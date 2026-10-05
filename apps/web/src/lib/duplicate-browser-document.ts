import { type DocumentIndex, hasDocumentDuplicates } from '@kamiazya/whiteboard-ports'
import { type ContentClock, loadBrowserDocument } from './browser-document-summary.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { DocumentSnapshot } from './whiteboard-client.js'

/**
 * What duplicating a browser-kept document MEANS, addressed by PATH.
 *
 * The index ROW has a path and nothing open; the document page has the open
 * document and reaches this the same way once it has flushed its pending save.
 *
 * The browser's own index runs it as ONE operation on the workspace record
 * (`DocumentDuplicates`, the same one the daemon's duplicate route runs), so
 * the copy lands beside its source, named after it, in one store write. An
 * index without that operation is refused, as the daemon's route refuses a
 * composition without it: a copy derived out here could not promise the same
 * placement or the same serialisation.
 */
export async function duplicateBrowserDocument(input: {
  index: DocumentIndex
  clock: ContentClock
  sourcePath: string
}): Promise<DocumentSnapshot> {
  const { index, clock, sourcePath } = input
  if (!hasDocumentDuplicates(index)) throw new Error(NO_DUPLICATES)
  const copy = await index.duplicateDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: sourcePath,
  })
  const snap = await loadBrowserDocument(index, copy.documentId, clock)
  if (snap === null) throw new Error('The copy vanished before it could be read.')
  return snap
}

const NO_DUPLICATES = 'This workspace cannot duplicate documents.'
