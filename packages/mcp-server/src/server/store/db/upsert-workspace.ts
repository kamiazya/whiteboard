import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { WorkspaceNotHeldError, WorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import type { TenantDatabase, TenantScoped } from './tenant-database.js'

/**
 * Did this write violate the segment's unique index — keyed on
 * (tenantId, namespace, segment) since migration 0046, on `segment` alone
 * before it — rather than fail for some other reason? SQLite names every
 * column of the index it refused, so `workspaces.segment` is in the message
 * under either.
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
export function isSegmentUniqueViolation(err: unknown): err is Error {
  if (!(err instanceof Error)) return false
  const { code, extendedCode } = err as { code?: unknown; extendedCode?: unknown }
  const unique = code === 'SQLITE_CONSTRAINT_UNIQUE' || extendedCode === 'SQLITE_CONSTRAINT_UNIQUE'
  return unique && err.message.includes('workspaces.segment')
}
export interface WorkspaceIdentity {
  segment?: string
  displayName?: string
}

/**
 * `segment`/`displayName` are ADR-0019's identity layers, claimed only on
 * the INITIAL insert — the `onConflict('id').doNothing()` below means a
 * bare call on an already-existing workspace (every `wbDocumentCreate
 * createWorkspace: true` call, for one) never touches them, so a name or
 * segment set elsewhere is never clobbered by a follow-up child write.
 */
export async function upsertWorkspaceRow(
  db: TenantScoped,
  workspaceId: string,
  identity: WorkspaceIdentity & { namespace?: string } = {},
): Promise<void> {
  const now = Date.now()
  const namespace = identity.namespace ?? SINGLE_PERSON_NAMESPACE
  try {
    await db
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        displayName: identity.displayName ?? null,
        segment: identity.segment ?? null,
        namespace,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  } catch (err) {
    // `onConflict` above names only the `id` unique constraint; a violation
    // of the SEPARATE segment index still raises normally and is translated
    // here into the named port error, so a caller sees a segment collision
    // distinctly from any other write failure.
    if (identity.segment !== undefined && isSegmentUniqueViolation(err)) {
      throw new WorkspaceSegmentTakenError(
        identity.segment,
        // A single-person keeper has one namespace; naming it says nothing.
        namespace === SINGLE_PERSON_NAMESPACE ? undefined : namespace,
      )
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
 * write it authorises. It is keyed on the row's own namespace, so a rename
 * collides only with segments that namespace already holds (ADR-0053) — the
 * namespace is never moved here. `heldBy`, when given, is the namespace the
 * row must still be held in for the write to land, and its absence from the
 * WHERE is the only difference between "no such workspace" (null) and
 * `WorkspaceNotHeldError`. The workspace's OWN segment is not a conflict —
 * the row it collides with is itself, and `where id = ?` means the update
 * is the row.
 */
export async function renameWorkspaceRow(
  db: TenantDatabase,
  workspaceId: string,
  identity: WorkspaceIdentity,
  heldBy?: string,
): Promise<{ namespace: string; segment: string | null; displayName: string | null } | null> {
  try {
    let update = db
      .updateTable('workspaces')
      .set({
        ...(identity.segment === undefined ? {} : { segment: identity.segment }),
        ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
        updatedAt: Date.now(),
      })
      .where('id', '=', workspaceId)
    // In the WHERE, so the holder is judged by the statement that writes: a
    // hand-over committed a moment earlier makes this update match nothing,
    // and a row it does not match is never checked against the unique index,
    // so a refused caller learns nothing about the namespace's segments.
    if (heldBy !== undefined) update = update.where('namespace', '=', heldBy)
    const updated = await update
      .returning(['namespace', 'segment', 'displayName'])
      .executeTakeFirst()
    if (updated !== undefined) return updated
    if (heldBy === undefined) return null
    // Only which refusal to name; the decision was the update's.
    const exists = await db
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', workspaceId)
      .executeTakeFirst()
    if (exists !== undefined) throw new WorkspaceNotHeldError(workspaceId, heldBy)
    return null
  } catch (err) {
    if (identity.segment !== undefined && isSegmentUniqueViolation(err)) {
      throw new WorkspaceSegmentTakenError(identity.segment)
    }
    throw err
  }
}
