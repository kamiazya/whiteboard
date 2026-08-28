import { WorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import type { Database } from './index.js'

/**
 * `segment`/`displayName` are ADR-0019's identity layers, claimed only on
 * the INITIAL insert — the `onConflict('id').doNothing()` below means a
 * bare call on an already-existing workspace (every `wb_document_create
 * createWorkspace: true` call, for one) never touches them, so a name or
 * segment set elsewhere is never clobbered by a follow-up child write.
 */
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
    if (
      identity.segment !== undefined &&
      err instanceof Error &&
      'code' in err &&
      (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      err.message.includes('workspaces.segment')
    ) {
      throw new WorkspaceSegmentTakenError(identity.segment)
    }
    throw err
  }
}
