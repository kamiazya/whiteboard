import { setWorkspacePinned } from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceNames } from '../../shared/api-contracts/document.js'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
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
  const wsRow = await db
    .selectFrom('workspaces')
    .select(['displayName'])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  const documentRows = await db
    .selectFrom('documents')
    .select(['path', 'displayName', 'isPinned', 'pinOrder'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  const documents: Record<string, string> = {}
  const pinned: Array<{ path: string; order: number }> = []
  for (const row of documentRows) {
    if (row.displayName !== null) {
      documents[row.path] = row.displayName
    }
    if (row.isPinned === 1) {
      pinned.push({ path: row.path, order: row.pinOrder ?? Number.MAX_SAFE_INTEGER })
    }
  }
  pinned.sort((a, b) => a.order - b.order)
  const out: WorkspaceNames = {
    documents,
    pinned: pinned.map((p) => p.path),
  }
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
  await requireDocumentRow(db, workspaceId, path)
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
  // Mirror into the workspace record's pinned list (dual-plane collapse
  // S4b): shared CRDT state every replica converges on, while the row
  // columns keep serving today's reads. setWorkspacePinned is idempotent,
  // so the no-op row branches stay no-ops here too. Fail-soft while the row
  // is what reads serve: a mirror hiccup must not fail a pin that already
  // durably committed.
  try {
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    if (workspaceDoc !== null) {
      setWorkspacePinned(workspaceDoc, documentId, pinned)
      await saveWorkspaceDoc(workspaceId, workspaceDoc)
    }
  } catch (err) {
    getLogger('names-store').warning(
      { workspaceId, path, err },
      'failed to mirror pin state into the workspace record',
    )
  }
  return loadWorkspaceNames(workspaceId)
}
