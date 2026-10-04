import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import {
  type ContentClock,
  ensureBrowserWorkspace,
  listBrowserDocuments,
  loadBrowserDocument,
} from './browser-document-summary.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { LoroStoreLike } from './loro-store.js'
import { newDocumentPathIn } from './new-document-path.js'
import type { DocumentSnapshot } from './whiteboard-client.js'
import { seedWorkspaceDocumentContent, touchIfWorkspaceBacked } from './workspace-content.js'

/**
 * Create a document AND seed its content record, as one operation.
 *
 * The seed is not optional bookkeeping. `updatedAt` now comes from the content
 * record's own envelope — the metadata row has no timestamp of its own, and
 * the port's `DocumentEntry` carries none — so a document created without one
 * has no last-edited time to report. It is also what lets a switch onto a
 * never-edited document find something to load.
 *
 * Every create path routes through here, so one that skips it is
 * unrepresentable rather than merely avoided.
 *
 * The index row is rolled back if the content write fails, so a failed create
 * never leaves a document with nothing behind it.
 */
export async function createSeededDocument(
  index: DocumentIndex,
  loro: LoroStoreLike,
  clock: ContentClock,
  name?: string,
  kind: DocumentSnapshot['kind'] = 'spatial',
  content?: Uint8Array,
): Promise<DocumentSnapshot> {
  await ensureBrowserWorkspace(index)
  const taken = (await listBrowserDocuments(index, clock).catch(() => [])).map((row) => row.path)
  const trimmed = name?.trim()
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: newDocumentPathIn('', taken),
    kind,
    ...(trimmed ? { name: trimmed } : {}),
  })
  try {
    // Tree-backed index: the node the create just made IS the content record
    // (its containers are the empty document), so a seed with content copies
    // into it and an empty create only stamps the clock. The legacy branch
    // keeps the per-document record for an index without a workspace
    // document behind it — injected test doubles included.
    const seededInTree =
      content !== undefined
        ? await seedWorkspaceDocumentContent(entry.documentId, content)
        : await touchIfWorkspaceBacked(entry.documentId)
    if (!seededInTree) {
      await loro.save(entry.documentId, content ?? loro.createEmptySnapshot())
    }
  } catch (err) {
    try {
      await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: entry.path })
    } catch {
      // Rollback is best-effort; a stray index row is harmless next to
      // reporting a create that did not happen.
    }
    throw err
  }
  const snap = await loadBrowserDocument(index, entry.documentId, clock)
  if (snap === null) throw new Error('created document vanished before it could be read')
  return snap
}
