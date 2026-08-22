import { readCoreFacets } from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument } from './document-io.js'

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
 * ponytail: O(N) document loads per request, same ceiling as
 * `computeBacklinks` — when a measured workspace makes this slow, both belong
 * to one event-fed facts projection (see ADR-0014's incremental mode).
 */
export async function computeDocumentTags(
  deps: ServerDeps,
  input: DocumentTagsInput,
): Promise<DocumentTagsOutput> {
  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  const documents: DocumentTagsOutput['documents'] = []
  for (const entry of entries) {
    let doc
    try {
      doc = (await loadDocument(deps, entry.documentId)).doc
    } catch {
      continue // no snapshot yet -> nothing stored, so no tags
    }
    const tags = readCoreFacets(doc)?.tags
    if (tags === undefined || tags.length === 0) continue
    documents.push({ documentId: entry.documentId, tags })
  }
  return { documents }
}
