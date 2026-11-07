import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentEntry, DocumentIndex } from '@kamiazya/whiteboard-ports'
import {
  type ContentClock,
  ensureBrowserWorkspace,
  listBrowserDocuments,
  loadBrowserDocument,
} from './browser-document-summary.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { touchContentTimestamp } from './content-timestamp.js'
import { newDocumentPathIn } from './new-document-path.js'
import type { DocumentSnapshot } from './whiteboard-client.js'

/**
 * Create a document AND seed its content record, as one operation, at the
 * next free `untitled` at the workspace root.
 *
 * The node the index's create makes IS the content record (its containers are
 * the empty document), so seeding is only stamping the listing clock — the
 * port's `DocumentEntry` carries no timestamp, and a document created without
 * one has no last-edited time to report.
 */
export async function createSeededDocument(
  index: DocumentIndex,
  clock: ContentClock,
  name?: string,
  kind: DocumentSnapshot['kind'] = 'spatial',
): Promise<DocumentSnapshot> {
  // A workspace not made yet lists as nothing taken, which is what it holds.
  const path = newDocumentPathIn(
    '',
    (await listBrowserDocuments(index, clock).catch(() => [])).map((row) => row.path),
  )
  const entry = await createSeededDocumentAt(index, {
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
 * create path comes through here, so the name is normalised once.
 */
export async function createSeededDocumentAt(
  index: DocumentIndex,
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
  await touchContentTimestamp(entry.documentId)
  return entry
}
