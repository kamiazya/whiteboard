import { WorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import type { Database } from './index.js'

/**
 * `segment`/`displayName` are ADR-0019's identity layers, claimed only on
 * the INITIAL insert — the `onConflict('id').doNothing()` below means a
 * bare call on an already-existing workspace (every `wb_document_create
 * createWorkspace: true` call, for one) never touches them, so a name or
 * segment set elsewhere is never clobbered by a follow-up child write.
 */

/**
 * Did this write violate the `workspaces_segment_unique` index (migration
 * 0018) rather than fail for some other reason?
 *
 * Both spellings are accepted because the driver's error SHAPE moved under
 * us: libsql 0.3.19 reported `code: 'SQLITE_CONSTRAINT_UNIQUE'`, while
 * 0.5.29 reports `code: 'SQLITE_CONSTRAINT'` with the detail in
 * `extendedCode`. Keying on `code` alone made a segment collision fall
 * through to a 500 instead of the 409 the route promises — caught by
 * workspaces.test.ts and mint-daemon.test.ts when the client was deduped,
 * which is the only reason it was not shipped.
 *
 * Only ONE of those arms can be raised by the driver the tree is pinned to
 * (`one-libsql-stack.test.ts`), so the end-to-end tests above exercise the
 * `extendedCode` arm and cannot reach the other — measured: deleting the
 * `code` arm left all 54 of them passing. `upsert-workspace.test.ts` drives
 * both shapes synthetically, which is what keeps the unreachable arm from
 * being dead code that reads as covered. It stays rather than being deleted
 * because this shape has moved once already, silently.
 */
function isSegmentUniqueViolation(err: unknown): err is Error {
  if (!(err instanceof Error)) return false
  const { code, extendedCode } = err as { code?: unknown; extendedCode?: unknown }
  const unique = code === 'SQLITE_CONSTRAINT_UNIQUE' || extendedCode === 'SQLITE_CONSTRAINT_UNIQUE'
  return unique && err.message.includes('workspaces.segment')
}
export interface WorkspaceIdentity {
  segment?: string
  displayName?: string
}

// A no-op when the workspace row already exists; displayName/segment are
// left untouched so a name set elsewhere does not get clobbered by a
// follow-up child write.
export async function upsertWorkspaceRow(
  db: Database,
  workspaceId: string,
  identity: WorkspaceIdentity = {},
): Promise<void> {
  const now = Date.now()
  try {
    await db
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        displayName: identity.displayName ?? null,
        segment: identity.segment ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  } catch (err) {
    // `onConflict` above names only the `id` unique constraint; a violation
    // of the SEPARATE `workspaces_segment_unique` index (migration 0018)
    // still raises normally and is translated here into the named port
    // error, so a caller sees a segment collision distinctly from any other
    // write failure.
    if (identity.segment !== undefined && isSegmentUniqueViolation(err)) {
      throw new WorkspaceSegmentTakenError(identity.segment)
    }
    throw err
  }
}

/**
 * The registry half of a workspace rename: an UPDATE of the two layers
 * ADR-0019 lets a workspace's owner choose.
 *
 * Distinct from `upsertWorkspaceRow` rather than a flag on it, because the
 * two want opposite things from an existing row — the upsert must never
 * clobber identity (see above), and this must write it. Answers the row as
 * it now stands so a caller does not read back through a second statement
 * that another writer could have landed between.
 *
 * The unique index is what makes the collision check indivisible: SQLite
 * refuses the UPDATE itself, so there is no window between a check and the
 * write it authorises. The workspace's OWN segment is not a conflict —
 * the row it collides with is itself, and `where id = ?` means the update
 * is the row.
 */
export async function renameWorkspaceRow(
  db: Database,
  workspaceId: string,
  identity: WorkspaceIdentity,
): Promise<{ segment: string | null; displayName: string | null } | null> {
  try {
    const updated = await db
      .updateTable('workspaces')
      .set({
        ...(identity.segment === undefined ? {} : { segment: identity.segment }),
        ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
        updatedAt: Date.now(),
      })
      .where('id', '=', workspaceId)
      .returning(['segment', 'displayName'])
      .executeTakeFirst()
    return updated ?? null
  } catch (err) {
    if (identity.segment !== undefined && isSegmentUniqueViolation(err)) {
      throw new WorkspaceSegmentTakenError(identity.segment)
    }
    throw err
  }
}
