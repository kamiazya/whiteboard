import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import {
  type BacklinkEntry,
  backlinksIn,
  ContentFactsCache,
} from '@kamiazya/whiteboard-reference-graph'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { LoroStoreLike } from './loro-store.js'
import { loadDocumentContent } from './workspace-content.js'

/**
 * The browser keeper's answer to "what links here": the reference graph the
 * daemon answers from, over this browser's own documents.
 *
 * The definition of the answer is the shared one (`backlinksIn`), and so is
 * the cache that keeps each document's facts between asks. What is the
 * browser's is only how a document is READ — the same read every surface
 * uses for a document nothing has open. The cache keys on the listing's
 * content digest, which this keeper's tree-backed index always supplies, so
 * an ask after an edit re-reads the edited document and nothing else.
 *
 * One cache per reader: a page makes one and keeps it across the documents
 * it switches between, which is where the reuse is.
 */
export function browserBacklinksReader(
  index: DocumentIndex,
  loro: LoroStoreLike,
): (documentId: string) => Promise<{
  backlinks: BacklinkEntry[]
  unlinkedMentions: BacklinkEntry[]
}> {
  const cache = new ContentFactsCache({
    // The workspace is the browser's active one — the only one this keeper
    // holds open — so the port's workspace argument has nothing to select.
    loadDocument: (_workspaceId, documentId) => loadDocumentContent(documentId, { loro }),
  })
  return async (documentId) => {
    const workspaceId = getBrowserWorkspaceId()
    const entries = await index.listDocuments({ workspaceId })
    return backlinksIn(entries, await cache.factsFor(workspaceId, entries), documentId)
  }
}
