import {
  readPinnedDocumentIds,
  readWorkspaceDocuments,
  resolveWorkspaceDocument,
  setWorkspaceDocumentName,
  setWorkspacePinned,
} from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceNames } from '../../shared/api-contracts/document.js'
import { getDataDir } from '../config.js'
import { validateDocumentPath, validateWorkspaceId } from '../validators.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { requireDocumentRow, upsertWorkspaceRow } from './db/upsert-workspace.js'
import { openWorkspaceDocIfStored, saveWorkspaceDoc } from './document-store.js'

export type { WorkspaceNames }

// Workspace + canvas display names and pin order. Backed by:
//   workspaces.displayName       -> WorkspaceNames.workspace
//   documents.displayName         -> WorkspaceNames.documents[path]
//   documents.isPinned + pinOrder -> WorkspaceNames.pinned (sorted by pinOrder)
//
// loadWorkspaceNames returns an empty state for workspaces with no rows. The
// previous filesystem implementation also returned an empty state when
// .names.json was missing, so the contract is unchanged for callers.

async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

export async function loadWorkspaceNames(workspaceId: string): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  // The WORKSPACE's own name stays in the workspaces table — it names the
  // container, not any document, and the registry row is its home.
  const wsRow = await db
    .selectFrom('workspaces')
    .select(['displayName'])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  // Document names and pins answer from the workspace record (S7): the
  // tree is what every replica converges on, and the boot fold carries any
  // pre-fold row-only state into it before this can be asked.
  const documents: Record<string, string> = {}
  const pinned: string[] = []
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc !== null) {
    const entries = readWorkspaceDocuments(workspaceDoc)
    const pathById = new Map<string, string>()
    for (const entry of entries) {
      pathById.set(entry.documentId, entry.path)
      if (entry.name !== undefined) documents[entry.path] = entry.name
    }
    for (const documentId of readPinnedDocumentIds(workspaceDoc)) {
      const path = pathById.get(documentId)
      if (path !== undefined) pinned.push(path)
    }
  }
  const out: WorkspaceNames = { documents, pinned }
  if (wsRow?.displayName) {
    out.workspace = wsRow.displayName
  }
  return out
}

export async function setWorkspaceName(workspaceId: string, name: string): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  const trimmed = name.trim()
  const db = await dbReady()
  await upsertWorkspaceRow(db, workspaceId)
  const now = Date.now()
  await db
    .updateTable('workspaces')
    .set({
      displayName: trimmed.length > 0 ? trimmed : null,
      updatedAt: now,
    })
    .where('id', '=', workspaceId)
    .execute()
  return loadWorkspaceNames(workspaceId)
}

export async function setDocumentDisplayName(
  workspaceId: string,
  path: string,
  name: string,
): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const trimmed = name.trim()
  const db = await dbReady()
  const documentId = await requireDocumentRow(db, workspaceId, path)
  const now = Date.now()
  await db
    .updateTable('documents')
    .set({
      displayName: trimmed.length > 0 ? trimmed : null,
      updatedAt: now,
    })
    .where('workspaceId', '=', workspaceId)
    .where('path', '=', path)
    .execute()
  // The workspace record is where reads answer from (S7), so this write is
  // primary, not a best-effort mirror: a failure surfaces to the caller.
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc !== null && resolveWorkspaceDocument(workspaceDoc, path) !== null) {
    setWorkspaceDocumentName(workspaceDoc, {
      documentId,
      ...(trimmed.length > 0 ? { name: trimmed } : {}),
    })
    await saveWorkspaceDoc(workspaceId, workspaceDoc)
  }
  return loadWorkspaceNames(workspaceId)
}

// Pin / unpin a canvas. Idempotent:
//   - pinned=true on a not-yet-pinned canvas: append at the end (max pinOrder+1)
//   - pinned=true on an already-pinned canvas: no-op, order preserved
//   - pinned=false: clear isPinned + pinOrder
export async function setDocumentPinned(
  workspaceId: string,
  path: string,
  pinned: boolean,
): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const db = await dbReady()
  const documentId = await requireDocumentRow(db, workspaceId, path)
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('documents')
      .select(['isPinned', 'pinOrder'])
      .where('workspaceId', '=', workspaceId)
      .where('path', '=', path)
      .executeTakeFirst()
    if (!row) return
    const isPinnedNow = row.isPinned === 1
    if (pinned && !isPinnedNow) {
      const max = await trx
        .selectFrom('documents')
        .select((eb) => eb.fn.max('pinOrder').as('maxOrder'))
        .where('workspaceId', '=', workspaceId)
        .where('isPinned', '=', 1)
        .executeTakeFirst()
      const nextOrder = (max?.maxOrder ?? -1) + 1
      await trx
        .updateTable('documents')
        .set({ isPinned: 1, pinOrder: nextOrder, updatedAt: Date.now() })
        .where('workspaceId', '=', workspaceId)
        .where('path', '=', path)
        .execute()
    } else if (!pinned && isPinnedNow) {
      await trx
        .updateTable('documents')
        .set({ isPinned: 0, pinOrder: null, updatedAt: Date.now() })
        .where('workspaceId', '=', workspaceId)
        .where('path', '=', path)
        .execute()
    }
  })
  // The workspace record's pinned list is what reads answer from (S7), so
  // this write is primary, not a best-effort mirror: a failure surfaces to
  // the caller. setWorkspacePinned is idempotent, so the no-op row branches
  // stay no-ops here too.
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc !== null) {
    setWorkspacePinned(workspaceDoc, documentId, pinned)
    await saveWorkspaceDoc(workspaceId, workspaceDoc)
  }
  return loadWorkspaceNames(workspaceId)
}
