import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import {
  type BacklinkEntry,
  backlinksIn,
  ContentFactsCache,
} from '@kamiazya/whiteboard-reference-graph'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { searchReady } from './search-core.js'
import { lazyContentRecord, withHeldDocument } from './workspace-content.js'

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
export function browserBacklinksReader(index: DocumentIndex): (documentId: string) => Promise<{
  backlinks: BacklinkEntry[]
  unlinkedMentions: BacklinkEntry[]
}> {
  // One workspace-record open per ask, shared by every document that ask
  // reads: the record holds them all, so a cold build would otherwise reopen
  // it once per document.
  let record = lazyContentRecord()
  const cache = new ContentFactsCache({
    // The workspace is the browser's active one — the only one this keeper
    // holds open — so the port's workspace argument has nothing to select.
    loadContent: async (_workspaceId, entry) =>
      withHeldDocument(await record.open(), entry.documentId, (held) =>
        held.contentWithTags(entry.kind),
      ),
  })
  const ask = async (documentId: string) => {
    // Extraction and the excerpts are the search core's.
    await searchReady()
    const asked = lazyContentRecord()
    record = asked
    try {
      const workspaceId = getBrowserWorkspaceId()
      const entries = await index.listDocuments({ workspaceId })
      return backlinksIn(entries, await cache.factsFor(workspaceId, entries), documentId)
    } finally {
      await asked.release()
    }
  }
  // One ask at a time: `loadContent` reads `record`, so an ask that overlapped
  // another could read through, or open, a record the other one gives back.
  let queued: Promise<unknown> = Promise.resolve()
  return (documentId) => {
    const answer = queued.then(() => ask(documentId))
    queued = answer.catch(() => undefined)
    return answer
  }
}
