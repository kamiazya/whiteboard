/**
 * "This workspace was removed from this browser" as a state the browser
 * keeper stores, rather than one it infers from a missing record.
 *
 * To every writer a missing record or registry row means "never created",
 * so a tab still holding a removed workspace's id — its backend keeps the
 * whole record in memory — would mint both again on its next keystroke or
 * create, bringing back everything the removal deleted. The tombstone is
 * what the two minting writers ask first: `BrowserWorkspaceDocs` before it
 * writes a first snapshot (`refuseUnlessHeld`), and the registry's
 * `createWorkspace` inside the transaction that would add the row.
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
import { openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import { request } from './idb-tx.js'

export const TOMBSTONE_STORE = 'meta'

function tombstoneKey(workspaceId: string): string {
  return `removedWorkspace:${workspaceId}`
}

/** A write refused because the workspace it targets was removed from this browser. */
class WorkspaceRemovedError extends Error {
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

/**
 * The refusal a workspace record's first write asks: the id is tombstoned,
 * or nothing here holds it — no registry row (a workspace this browser
 * keeps) and no replica claim (`isReplica`, a daemon workspace's copy).
 *
 * The second half is what a forgotten replica needs instead of a tombstone.
 * Its copy takes none — pulling it again must be allowed to store it — so a
 * page still holding the record in another tab would otherwise write all of
 * it back, and with the claim gone it would land unsealed, under an id no
 * listing names. Answered as "removed" because that is what it is: an id
 * this browser once held and no longer does.
 */
export async function refuseUnlessHeld(
  workspaceId: string,
  isReplica: boolean,
  dbName?: string,
): Promise<void> {
  const db = await openWhiteboardDb(dbName)
  try {
    const tx = db.transaction([TOMBSTONE_STORE, WORKSPACES_STORE], 'readonly')
    const [tombstone, row] = await Promise.all([
      request(tx.objectStore(TOMBSTONE_STORE).getKey(tombstoneKey(workspaceId))),
      request(tx.objectStore(WORKSPACES_STORE).getKey(workspaceId)),
    ])
    if (tombstone !== undefined) throw new WorkspaceRemovedError(workspaceId)
    if (row === undefined && !isReplica) throw new WorkspaceRemovedError(workspaceId)
  } finally {
    db.close()
  }
}
