import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { ContentFactsCache } from '../references/content-facts-cache.js'
import type { ServerDeps } from '../server-deps.js'

export const documentTagsInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
export type DocumentTagsInput = z.infer<typeof documentTagsInputSchema>

export const documentTagsOutputSchema = z
  .object({
    /**
     * Only documents that CARRY tags. Spatial documents cannot (core facets
     * are a markdown-document concern, ADR-0009/0013 — `readCoreFacets`
     * answers undefined for them), and listing tagless ones would make every
     * client re-filter the same emptiness.
     */
    documents: z.array(
      z.object({ documentId: documentIdSchema, tags: z.array(z.string()).min(1) }).strict(),
    ),
  })
  .strict()
export type DocumentTagsOutput = z.infer<typeof documentTagsOutputSchema>

/**
 * The workspace's tag projection, for the document browser's search and
 * filter chips.
 *
 * Served from the stamp-validated ContentFactsCache: only documents whose
 * frontier moved are reloaded (ADR-0014's incremental mode, cache form).
 */
export async function computeDocumentTags(
  deps: ServerDeps,
  input: DocumentTagsInput,
  cache: ContentFactsCache = new ContentFactsCache(),
): Promise<DocumentTagsOutput> {
  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  const content = await cache.factsFor(deps, entries)
  const documents: DocumentTagsOutput['documents'] = []
  for (const entry of entries) {
    const tags = content.get(entry.documentId)?.tags
    if (tags === undefined || tags.length === 0) continue
    documents.push({ documentId: entry.documentId, tags: [...tags] })
  }
  return { documents }
}
