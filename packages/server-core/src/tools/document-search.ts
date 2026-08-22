import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { fullTextSearch, type SearchableDocument } from '@kamiazya/whiteboard-search'
import { z } from 'zod'
import { ContentFactsCache } from '../references/content-facts-cache.js'
import type { Embedder } from '../search/embedder.js'
import { rankByVector } from '../search/embedder.js'
import { fuseByRank } from '../search/rrf.js'
import type { ServerDeps } from '../server-deps.js'

export const documentSearchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    query: z.string().min(1).describe('What to find. Japanese matches without a dictionary.'),
    kind: documentKindSchema.optional().describe('Restrict to markdown or spatial documents.'),
    tags: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Restrict to documents carrying EVERY listed tag exactly.'),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict()
export type DocumentSearchInput = z.input<typeof documentSearchInputSchema>

export const documentSearchOutputSchema = z
  .object({
    results: z.array(
      z
        .object({
          documentId: documentIdSchema,
          path: documentPathSchema,
          name: z.string().min(1).optional(),
          kind: documentKindSchema.optional(),
          /**
           * BM25 over this workspace's corpus, or the fused rank score when
           * semantic search is on. Comparable within ONE response only.
           */
          score: z.number(),
          /**
           * Excerpts around the first match per matching text source. A hit
           * found only by meaning has no keyword to excerpt around, so it
           * carries the opening of its text instead.
           */
          contexts: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict()
export type DocumentSearchOutput = z.infer<typeof documentSearchOutputSchema>

/**
 * Lexical search across a workspace: markdown bodies, canvas text (nodes,
 * group labels, edge labels — a canvas means through its RELATIONS, so edge
 * labels are content, not decoration), names and paths.
 *
 * Corpus served from the stamp-validated ContentFactsCache shared with
 * backlinks/mentions and tags — only documents whose frontier moved are
 * reloaded (ADR-0014's incremental mode, cache form).
 *
 * With `deps.embedder` supplied it also searches by MEANING, fusing the two
 * rankings; without one it is lexical search and nothing else.
 */
export function createDocumentSearchTool(
  deps: ServerDeps,
  cache: ContentFactsCache = new ContentFactsCache(),
) {
  return {
    name: 'wb_document_search' as const,
    description:
      'Find documents by content: full-text over markdown bodies and canvas text (nodes, group labels, edge labels), plus names and paths. Japanese works without a dictionary (character bigrams). Optional kind/tags filters. Returns ranked matches with context excerpts; scores compare within one response only.',
    inputSchema: documentSearchInputSchema,
    outputSchema: documentSearchOutputSchema,
    async execute(input: DocumentSearchInput): Promise<DocumentSearchOutput> {
      const parsed = documentSearchInputSchema.parse(input)
      const entries = await deps.documentIndex.listDocuments({ workspaceId: parsed.workspaceId })
      const content = await cache.factsFor(deps, parsed.workspaceId, entries)

      const searchable: (SearchableDocument & { kind?: 'markdown' | 'spatial' })[] = []
      for (const entry of entries) {
        const facts = content.get(entry.documentId)
        if (facts === undefined) continue
        if (parsed.kind !== undefined && entry.kind !== parsed.kind) continue
        if (parsed.tags !== undefined) {
          const tags = facts.tags ?? []
          if (!parsed.tags.every((tag) => tags.includes(tag))) continue
        }
        searchable.push({
          documentId: entry.documentId,
          path: entry.path,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          texts: [...facts.texts],
        })
      }

      const byId = new Map(searchable.map((doc) => [doc.documentId, doc]))
      const describe = (documentId: string, score: number, contexts: readonly string[]) => {
        const doc = byId.get(documentId)
        return {
          documentId,
          path: doc?.path ?? documentId,
          ...(doc?.name === undefined ? {} : { name: doc.name }),
          ...(doc?.kind === undefined ? {} : { kind: doc.kind }),
          score,
          contexts: [...contexts],
        }
      }

      // The optional semantic half. Absent, this returns exactly what it
      // returned before embeddings existed; supplied, its ranking is FUSED
      // with BM25's by rank rather than mixed by score, and any failure
      // inside it degrades to lexical-only rather than failing the search.
      const { embedder } = deps
      if (embedder === undefined) {
        const hits = fullTextSearch(searchable, parsed.query, { limit: parsed.limit })
        return { results: hits.map((hit) => describe(hit.documentId, hit.score, hit.contexts)) }
      }

      // Fusion needs the WHOLE lexical ranking, not the page the caller asked
      // for: a document the vector half also likes can climb from rank 20.
      const lexical = fullTextSearch(searchable, parsed.query, { limit: searchable.length })
      const semantic = await rankSemantically(
        deps,
        cache,
        parsed.workspaceId,
        entries.filter((entry) => byId.has(entry.documentId)),
        parsed.query,
        embedder,
      )
      if (semantic === undefined) {
        return {
          results: lexical
            .slice(0, parsed.limit)
            .map((hit) => describe(hit.documentId, hit.score, hit.contexts)),
        }
      }

      const fused = fuseByRank([lexical.map((hit) => hit.documentId), semantic])
      const ordered = [...fused.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([documentId]) => documentId)
      const contexts = new Map(lexical.map((hit) => [hit.documentId, hit.contexts]))
      return {
        results: ordered
          .slice(0, parsed.limit)
          .map((documentId) =>
            describe(
              documentId,
              fused.get(documentId) ?? 0,
              contexts.get(documentId) ?? openingOf(byId.get(documentId)),
            ),
          ),
      }
    },
  }
}

/**
 * The vector ranking, or `undefined` when the embedder cannot answer.
 *
 * Failure here is NOT a search failure: semantic recall is an addition, and
 * a model that is still loading, out of memory, or simply absent should cost
 * the user nothing worse than the lexical results they had before.
 */
async function rankSemantically(
  deps: ServerDeps,
  cache: ContentFactsCache,
  workspaceId: string,
  entries: readonly Parameters<ContentFactsCache['factsFor']>[2][number][],
  query: string,
  embedder: Embedder,
): Promise<string[] | undefined> {
  try {
    const documents = await cache.vectorsFor(deps, workspaceId, entries, embedder)
    if (documents.length === 0) return []
    const [queryVector] = await embedder.embed([query], 'query')
    if (queryVector === undefined) return undefined
    return rankByVector(queryVector, documents)
  } catch {
    return undefined
  }
}

/** First line of a document's text, for a hit with no keyword to excerpt. */
function openingOf(doc: { texts: readonly string[] } | undefined): string[] {
  const text = doc?.texts.find((candidate) => candidate.trim() !== '')
  return text === undefined ? [] : [text.slice(0, 120)]
}
