import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentEntry, DocumentIndex } from '@kamiazya/whiteboard-ports'
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
import { touchIfWorkspaceBacked } from './workspace-content.js'

/**
 * Create a document AND seed its content record, as one operation, at the
 * next free `untitled` at the workspace root.
 *
 * The seed is not optional bookkeeping. `updatedAt` now comes from the content
 * record's own envelope — the metadata row has no timestamp of its own, and
 * the port's `DocumentEntry` carries none — so a document created without one
 * has no last-edited time to report. It is also what lets a switch onto a
 * never-edited document find something to load.
 */
export async function createSeededDocument(
  index: DocumentIndex,
  loro: LoroStoreLike,
  clock: ContentClock,
  name?: string,
  kind: DocumentSnapshot['kind'] = 'spatial',
): Promise<DocumentSnapshot> {
  // A workspace not made yet lists as nothing taken, which is what it holds.
  const path = newDocumentPathIn(
    '',
    (await listBrowserDocuments(index, clock).catch(() => [])).map((row) => row.path),
  )
  const entry = await createSeededDocumentAt(index, loro, {
    path,
    kind,
    ...(name === undefined ? {} : { name }),
  })
  const snap = await loadBrowserDocument(index, entry.documentId, clock)
  if (snap === null) throw new Error('created document vanished before it could be read')
  return snap
}

/**
 * The same create at a path the caller names — the Files panel's. Every
 * create path comes through here, so the name is normalised and the choice
 * between the record and the per-document store is made once.
 */
export async function createSeededDocumentAt(
  index: DocumentIndex,
  loro: LoroStoreLike,
  input: { readonly path: string; readonly kind: DocumentKind; readonly name?: string },
): Promise<DocumentEntry> {
  await ensureBrowserWorkspace(index)
  const trimmed = input.name?.trim()
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: input.path,
    kind: input.kind,
    ...(trimmed ? { name: trimmed } : {}),
  })
  await seedCreatedDocument(index, loro, entry)
  return entry
}

/**
 * Gives a document the index just created its content record.
 *
 * Tree-backed index: the node the create just made IS the content record (its
 * containers are the empty document), so this only stamps the clock. The
 * per-document store is written only for an index with no workspace record
 * behind it — injected test doubles — since a record written there for a
 * document the tree holds is a second copy that outlives the document's
 * delete and answers reads for it.
 *
 * The index row is rolled back if the content write fails, so a failed create
 * never leaves a document with nothing behind it.
 */
async function seedCreatedDocument(
  index: DocumentIndex,
  loro: LoroStoreLike,
  entry: { readonly documentId: string; readonly path: string },
): Promise<void> {
  try {
    if (!(await touchIfWorkspaceBacked(entry.documentId))) {
      await loro.save(entry.documentId, loro.createEmptySnapshot())
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
}
