import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { ContentFactsCache } from '../references/content-facts-cache.js'
import { fullTextSearch, type SearchableDocument } from '../search/full-text.js'
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
          /** BM25 over this workspace's corpus — comparable within ONE response only. */
          score: z.number(),
          /** Excerpts around the first match per matching text source. */
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
      const results = fullTextSearch(searchable, parsed.query, { limit: parsed.limit }).map(
        (hit) => {
          const doc = byId.get(hit.documentId)
          return {
            documentId: hit.documentId,
            path: doc?.path ?? hit.documentId,
            ...(doc?.name === undefined ? {} : { name: doc.name }),
            ...(doc?.kind === undefined ? {} : { kind: doc.kind }),
            score: hit.score,
            contexts: [...hit.contexts],
          }
        },
      )
      return { results }
    },
  }
}
