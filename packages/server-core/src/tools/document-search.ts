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
import { assertVectorWidth, rankByVector } from '../search/embedder.js'
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
          /**
           * Where this document sat in the keyword ranking, 1-based, or
           * absent when keywords never matched it.
           *
           * ABSENT IS THE USEFUL CASE: it says there is nothing in
           * `contexts` to highlight, because the excerpt is the opening of
           * the document rather than a match. A caller that highlights
           * needs to know this and cannot infer it from the excerpt's
           * shape. On this project's own docs it is not an edge case —
           * 16 of 50 judged queries score no document lexically at all.
           *
           * 1-based deliberately: a rank of 0 is falsy, so `if (hit.lexicalRank)`
           * would read the top hit as no hit.
           */
          lexicalRank: z.number().int().min(1).optional(),
          /**
           * Where this document sat in the semantic ranking, 1-based, or
           * absent when no embedder was configured.
           *
           * Reported rather than folded into a "why did this match" label
           * because every embedded document appears in the semantic
           * ranking — so mere PRESENCE there carries no information, and a
           * label built on it would tell the caller "meaning helped" about
           * every result. Whether a semantic rank is good enough to have
           * promoted a document is a judgement with a threshold in it, and
           * the threshold belongs to whoever is displaying the results.
           */
          semanticRank: z.number().int().min(1).optional(),
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
      /** documentId -> 1-based position, for whichever rankings exist. */
      const ranksOf = (ranking: readonly string[]): Map<string, number> =>
        new Map(ranking.map((documentId, index) => [documentId, index + 1]))
      const describe = (
        documentId: string,
        score: number,
        contexts: readonly string[],
        ranks: { lexical?: number; semantic?: number },
      ) => {
        const doc = byId.get(documentId)
        return {
          documentId,
          path: doc?.path ?? documentId,
          ...(doc?.name === undefined ? {} : { name: doc.name }),
          ...(doc?.kind === undefined ? {} : { kind: doc.kind }),
          score,
          contexts: [...contexts],
          ...(ranks.lexical === undefined ? {} : { lexicalRank: ranks.lexical }),
          ...(ranks.semantic === undefined ? {} : { semanticRank: ranks.semantic }),
        }
      }

      // The optional semantic half. Absent, this returns exactly what it
      // returned before embeddings existed; supplied, its ranking is FUSED
      // with BM25's by rank rather than mixed by score, and any failure
      // inside it degrades to lexical-only rather than failing the search.
      const { embedder } = deps
      if (embedder === undefined) {
        // The returned page IS the prefix of the full ranking here, so the
        // index is the rank.
        const hits = fullTextSearch(searchable, parsed.query, { limit: parsed.limit })
        return {
          results: hits.map((hit, index) =>
            describe(hit.documentId, hit.score, hit.contexts, { lexical: index + 1 }),
          ),
        }
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
            .map((hit, index) =>
              describe(hit.documentId, hit.score, hit.contexts, { lexical: index + 1 }),
            ),
        }
      }

      const fused = fuseByRank([lexical.map((hit) => hit.documentId), semantic])
      const contexts = new Map(lexical.map((hit) => [hit.documentId, hit.contexts]))
      // Ranks come from the COMPLETE rankings, not from the page returned:
      // "3rd of 45" and "3rd of 5" are different facts, and only the former
      // survives a change of `limit`.
      const lexicalRanks = ranksOf(lexical.map((hit) => hit.documentId))
      const semanticRanks = ranksOf(semantic)
      /**
       * Fused ties are the NORM, not an edge case: reciprocal-rank sums
       * collide by construction, so a document at lexical 1 / semantic 2
       * scores exactly what one at lexical 2 / semantic 1 does. Of the 400
       * rank pairs inside the top 20, only 210 distinct scores exist and
       * 190 are shared.
       *
       * Broken on evidence rather than on identity. The document whose
       * keywords matched better wins, because those are the words the user
       * actually typed; between two documents keywords never matched, the
       * closer meaning wins. Ranks within a list are unique, so this is a
       * total order with no appeal to a document id — which mattered, since
       * an id is `encodeTime(Date.now()) + encodeRandom()` and ordering by
       * it answered "which was written first", with chance deciding inside
       * a millisecond.
       */
      const FAR = Number.MAX_SAFE_INTEGER
      const ordered = [...fused.entries()]
        .sort(
          (a, b) =>
            b[1] - a[1] ||
            (lexicalRanks.get(a[0]) ?? FAR) - (lexicalRanks.get(b[0]) ?? FAR) ||
            (semanticRanks.get(a[0]) ?? FAR) - (semanticRanks.get(b[0]) ?? FAR),
        )
        .map(([documentId]) => documentId)
      return {
        results: ordered
          .slice(0, parsed.limit)
          .map((documentId) =>
            describe(
              documentId,
              fused.get(documentId) ?? 0,
              contexts.get(documentId) ?? openingOf(byId.get(documentId)),
              { lexical: lexicalRanks.get(documentId), semantic: semanticRanks.get(documentId) },
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
    assertVectorWidth([queryVector], embedder)
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
