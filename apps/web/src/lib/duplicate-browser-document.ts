import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { createSeededDocument } from './create-seeded-document.js'
import { deriveCopyName } from './derive-copy-name.js'
import { type ContentClock, listLocalDocuments } from './local-document-summary.js'
import type { LoroStoreLike } from './loro-store.js'
import type { DocumentSnapshot } from './whiteboard-client.js'
import { loadDocumentContent } from './workspace-content.js'

/**
 * What duplicating a browser-kept document MEANS, addressed by PATH.
 *
 * The index ROW has a path and nothing open; the document page has the open
 * document and reaches this the same way once it has flushed its pending save.
 * Keeping one definition is what stops the two surfaces drifting on what a
 * copy is — the daemon side learned that the hard way, where duplicating from
 * a row filed a markdown document as a canvas.
 *
 * The copy is a DEEP one: the source's record is read through
 * `mergeToSnapshot` (snapshot + delta log collapsed into one), so the new
 * document shares no bytes, deltas or LoroDoc with the source.
 */
export async function duplicateBrowserDocument(input: {
  index: DocumentIndex
  loro: LoroStoreLike
  clock: ContentClock
  sourcePath: string
}): Promise<DocumentSnapshot> {
  const { index, loro, clock, sourcePath } = input
  const workspaceId = getBrowserWorkspaceId()
  const source = await index.resolveDocument({ workspaceId, path: sourcePath })
  // Refusing beats copying an empty document under a name that claims to be a
  // copy of something: the row may have been deleted between the click and
  // this read, and a copy of nothing is not what was asked for.
  if (source === null) throw new Error(`No document at "${sourcePath}" to duplicate.`)

  return await createSeededDocument(
    index,
    loro,
    clock,
    deriveCopyName(
      source.name ?? sourcePath,
      (await listLocalDocuments(index, clock).catch(() => [])).map((row) => row.name),
    ),
    source.kind,
    await readMergedContent(loro, source.documentId),
  )
}

/**
 * The document's current bytes, through the one read every browser surface
 * uses for a document it has not opened — so a copy is of the same content a
 * thumbnail, an embed or a backlink would read.
 */
async function readMergedContent(loro: LoroStoreLike, documentId: string): Promise<Uint8Array> {
  const doc = await loadDocumentContent(documentId, { loro })
  if (doc === null) throw new Error('The document data could not be read for duplication.')
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}
