/**
 * Where browser-kept document CONTENT is read from and seeded to, now that
 * the workspace document is the source of truth.
 *
 * Every reader that used to load a per-document Loro record goes through
 * `loadDocumentContent`: the workspace document's tree node answers first
 * (that is where the editor persists), and the legacy per-document record
 * stays as the fallback for a document nothing has folded yet — including
 * jsdom tests whose injected store double is the only storage there is.
 */
import {
  projectWorkspaceDocument,
  resolveWorkspaceDocumentById,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { Loro, type LoroDoc } from 'loro-crdt'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { LoroStore, touchContentTimestamp } from './loro-store.js'

/**
 * A document's CURRENT content as a standalone Loro document (a value
 * projection — fresh oplog, current state), or null when neither the
 * workspace tree nor the legacy store holds it readably.
 */
export async function loadDocumentContent(
  documentId: string,
  dbName?: string,
): Promise<LoroDoc | null> {
  const projected = await loadWorkspaceDocumentProjection(documentId, dbName)
  if (projected !== null) return projected
  const result = await new LoroStore(dbName)
    .load(documentId)
    .catch(() => ({ kind: 'not-found' }) as const)
  if (result.kind !== 'ok') return null
  const doc = new Loro()
  doc.import(result.snapshot)
  for (const delta of result.deltas ?? []) doc.import(delta)
  return doc
}

/**
 * Writes standalone-document bytes INTO an existing tree node (a create
 * seed, a duplicate's copy). Returns false when the workspace record or the
 * node is absent — the caller falls back to the legacy per-document store,
 * which is also what keeps injected test doubles working.
 */
/**
 * The tree-only half of `loadDocumentContent`, for callers with their own
 * legacy fallback (an injected store double, say): the projection when the
 * tree holds the document, null otherwise.
 */
export async function loadWorkspaceDocumentProjection(
  documentId: string,
  dbName?: string,
): Promise<LoroDoc | null> {
  const workspace = await new BrowserWorkspaceDocs(dbName)
    .open(getBrowserWorkspaceId())
    .catch(() => null)
  if (workspace === null) return null
  return projectWorkspaceDocument(workspace, documentId)
}

/**
 * True — after stamping the listing clock — exactly when the tree holds this
 * document, i.e. when its node's containers already ARE the (empty) content
 * record and a create has nothing else to seed.
 */
export async function touchIfWorkspaceBacked(
  documentId: string,
  dbName?: string,
): Promise<boolean> {
  const workspace = await new BrowserWorkspaceDocs(dbName)
    .open(getBrowserWorkspaceId())
    .catch(() => null)
  if (workspace === null) return false
  if (resolveWorkspaceDocumentById(workspace, documentId) === null) return false
  await touchContentTimestamp(documentId, dbName)
  return true
}

export async function seedWorkspaceDocumentContent(
  documentId: string,
  content: Uint8Array,
  dbName?: string,
): Promise<boolean> {
  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await docs.open(getBrowserWorkspaceId()).catch(() => null)
  if (workspace === null) return false
  const source = new Loro()
  source.import(content)
  if (!writeWorkspaceDocumentContent(workspace, documentId, source)) return false
  await docs.save(getBrowserWorkspaceId(), workspace)
  await touchContentTimestamp(documentId, dbName)
  return true
}
