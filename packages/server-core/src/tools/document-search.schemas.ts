/**
 * wb_document_search's input and output contracts, and nothing else.
 *
 * Schemas only, so `../contracts.ts` can publish them to a BROWSER without
 * the tool's own graph coming with them. See that file for why the split
 * exists rather than being a matter of taste.
 */
import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const documentSearchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('The workspace to search.'),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'What to find, matched against content. Japanese matches without a dictionary. Omit it to answer every document the filters admit — a tag is frontmatter, not content, so "which documents carry this tag" is a filter alone.',
      ),
    kind: documentKindSchema.optional().describe('Restrict to markdown or spatial documents.'),
    tags: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Restrict to documents carrying EVERY listed tag exactly.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('How many results to answer, at most.'),
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
