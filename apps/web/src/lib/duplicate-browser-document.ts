import { deriveCopyName, deriveCopyPath } from '@kamiazya/whiteboard-model'
import {
  type DocumentIndex,
  hasDocumentDuplicates,
  NoRoomForCopyError,
} from '@kamiazya/whiteboard-ports'
import {
  type ContentClock,
  listBrowserDocuments,
  loadBrowserDocument,
} from './browser-document-summary.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { createSeededDocument } from './create-seeded-document.js'
import type { LoroStoreLike } from './loro-store.js'
import type { DocumentSnapshot } from './whiteboard-client.js'
import { loadDocumentContent } from './workspace-content.js'

/**
 * What duplicating a browser-kept document MEANS, addressed by PATH.
 *
 * The index ROW has a path and nothing open; the document page has the open
 * document and reaches this the same way once it has flushed its pending save.
 *
 * The browser's own index runs it as ONE operation on the workspace record
 * (`DocumentDuplicates`, the same one the daemon's duplicate route runs), so
 * the copy lands beside its source, named after it, in one store write.
 *
 * An index with no workspace record behind it — the row-backed doubles a page
 * test injects — has no such operation; there the copy is made through the
 * port and the legacy content record, under the same placement and naming
 * rules, so a page test sees what a person would.
 */
export async function duplicateBrowserDocument(input: {
  index: DocumentIndex
  loro: LoroStoreLike
  clock: ContentClock
  sourcePath: string
}): Promise<DocumentSnapshot> {
  const { index, clock, sourcePath } = input
  const workspaceId = getBrowserWorkspaceId()
  if (hasDocumentDuplicates(index)) {
    const copy = await index.duplicateDocument({ workspaceId, path: sourcePath })
    const snap = await loadBrowserDocument(index, copy.documentId, clock)
    if (snap === null) throw new Error('The copy vanished before it could be read.')
    return snap
  }
  return duplicateThroughThePort(input)
}

async function duplicateThroughThePort(input: {
  index: DocumentIndex
  loro: LoroStoreLike
  clock: ContentClock
  sourcePath: string
}): Promise<DocumentSnapshot> {
  const { index, loro, clock, sourcePath } = input
  const source = await index.resolveDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: sourcePath,
  })
  // Refusing beats copying an empty document under a name that claims to be a
  // copy of something: the row may have been deleted between the click and
  // this read, and a copy of nothing is not what was asked for.
  if (source === null) throw new Error(`No document at "${sourcePath}" to duplicate.`)
  const rows = await listBrowserDocuments(index, clock).catch(() => [])
  const path = deriveCopyPath(
    source.path,
    rows.map((row) => row.path),
  )
  if (path === null) throw new NoRoomForCopyError(source.path)
  return await createSeededDocument(
    index,
    loro,
    clock,
    deriveCopyName(
      source.name ?? source.path,
      rows.map((row) => row.name),
    ),
    source.kind,
    await readMergedContent(loro, source.documentId),
    path,
  )
}

/**
 * The document's current bytes, through the one read every browser surface
 * uses for a document it has not opened.
 */
async function readMergedContent(loro: LoroStoreLike, documentId: string): Promise<Uint8Array> {
  // One refusal for a person, whichever way the read failed: absent content
  // and a read that did not complete are the same answer to "why was no copy
  // made", and the page shows this message as it is. The cause stays attached.
  const doc = await loadDocumentContent(documentId, { loro }).catch((cause: unknown) => {
    throw new Error(UNREADABLE_FOR_DUPLICATION, { cause })
  })
  if (doc === null) throw new Error(UNREADABLE_FOR_DUPLICATION)
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

const UNREADABLE_FOR_DUPLICATION = 'The document data could not be read for duplication.'
