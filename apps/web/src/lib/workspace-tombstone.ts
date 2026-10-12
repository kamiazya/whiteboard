/**
 * "This workspace was removed from this browser" as a state the browser
 * keeper stores, rather than one it infers from a missing record.
 *
 * To every writer a missing record or registry row means "never created",
 * so a tab still holding a removed workspace's id — its backend keeps the
 * whole record in memory — would mint both again on its next keystroke or
 * create, bringing back everything the removal deleted. The tombstone is
 * what the two minting writers ask first: `BrowserWorkspaceDocs` before it
 * writes a first snapshot, and the registry's `createWorkspace` inside the
 * transaction that would add the row.
 *
 * Kept forever, deliberately. A workspace id is a ULID minted once and never
 * reused, so a tombstone can never refuse a legitimate write, and it costs a
 * few dozen bytes per removed workspace. A GC would need to know that no tab
 * anywhere still holds the id, which nothing can know.
 *
 * In the `meta` store under a key per workspace, so the registry's readers —
 * listing, resolution, the first-row fallback — never meet a row they would
 * have to skip.
 */
import { openWhiteboardDb } from './browser-idb.js'
import { request } from './idb-tx.js'

export const TOMBSTONE_STORE = 'meta'

function tombstoneKey(workspaceId: string): string {
  return `removedWorkspace:${workspaceId}`
}

/** A write refused because the workspace it targets was removed from this browser. */
export class WorkspaceRemovedError extends Error {
  override readonly name = 'WorkspaceRemovedError'
  constructor(readonly workspaceId: string) {
    super(`workspace ${workspaceId} was removed from this browser`)
  }
}

export function isWorkspaceRemovedError(err: unknown): err is WorkspaceRemovedError {
  return err instanceof WorkspaceRemovedError
}

/** Writes the tombstone inside a caller's transaction, which must include the tombstone store. */
export function writeTombstone(tx: IDBTransaction, workspaceId: string): void {
  // The value is for a person reading the store; only the key's presence is read.
  tx.objectStore(TOMBSTONE_STORE).put(new Date().toISOString(), tombstoneKey(workspaceId))
}

/** Throws `WorkspaceRemovedError` when the id is tombstoned, inside a caller's transaction. */
export async function refuseIfRemovedIn(tx: IDBTransaction, workspaceId: string): Promise<void> {
  const found = await request(tx.objectStore(TOMBSTONE_STORE).getKey(tombstoneKey(workspaceId)))
  if (found !== undefined) throw new WorkspaceRemovedError(workspaceId)
}

/** The same refusal in a transaction of its own. */
export async function refuseIfRemoved(workspaceId: string, dbName?: string): Promise<void> {
  const db = await openWhiteboardDb(dbName)
  try {
    const tx = db.transaction([TOMBSTONE_STORE], 'readonly')
    await refuseIfRemovedIn(tx, workspaceId)
  } finally {
    db.close()
  }
}
