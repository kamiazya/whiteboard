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
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import {
  openWorkspaceDocIfStored,
  requireDocumentAtPath,
  saveWorkspaceDoc,
} from './document-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

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
  const documentId = await requireDocumentAtPath(workspaceId, path)
  // The workspace record is the only home this write has (S7): the rows are
  // no longer maintained, so a failure here surfaces to the caller. Under
  // the workspace write lock like every other read-modify-write of the
  // record — the open and the save must see no concurrent tree write.
  await withWorkspaceWriteLock(workspaceId, async () => {
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    if (workspaceDoc !== null && resolveWorkspaceDocument(workspaceDoc, path) !== null) {
      setWorkspaceDocumentName(workspaceDoc, {
        documentId,
        ...(trimmed.length > 0 ? { name: trimmed } : {}),
      })
      await saveWorkspaceDoc(workspaceId, workspaceDoc)
    }
  })
  return loadWorkspaceNames(workspaceId)
}

// Pin / unpin a document. Idempotent: re-pinning keeps the position it
// already has in the workspace record's pinned list; unpinning removes it.
export async function setDocumentPinned(
  workspaceId: string,
  path: string,
  pinned: boolean,
): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const documentId = await requireDocumentAtPath(workspaceId, path)
  // The workspace record's pinned list is the only home this write has
  // (S7): the rows are no longer maintained, so a failure surfaces. Locked
  // for the same reason as setDocumentDisplayName above.
  await withWorkspaceWriteLock(workspaceId, async () => {
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    if (workspaceDoc !== null) {
      setWorkspacePinned(workspaceDoc, documentId, pinned)
      await saveWorkspaceDoc(workspaceId, workspaceDoc)
    }
  })
  return loadWorkspaceNames(workspaceId)
}
