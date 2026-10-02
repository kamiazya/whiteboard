import type { TenantDatabase } from './tenant-database.js'
import { isSegmentUniqueViolation } from './upsert-workspace.js'

/**
 * Gives a workspace that has no segment the one named, unless some workspace
 * already holds it. Answers whether this call is the one that assigned it.
 *
 * A third write beside `upsertWorkspaceRow` (which never touches an existing
 * row's identity) and `renameWorkspaceRow` (which overwrites it): this one
 * fills an EMPTY segment and refuses everything else, so a boot step can run
 * it every time without ever taking a name from a workspace that has one or
 * from the workspace that holds the segment.
 *
 * A collision is an answer, not an error. The unique index (migration 0018)
 * is what refuses a held segment, in the same statement as the write, so
 * there is no window between a check and the update for another process on
 * the data directory to fall into.
 */
export async function claimWorkspaceSegment(
  db: TenantDatabase,
  workspaceId: string,
  segment: string,
): Promise<boolean> {
  try {
    const result = await db
      .updateTable('workspaces')
      .set({ segment, updatedAt: Date.now() })
      .where('id', '=', workspaceId)
      .where('segment', 'is', null)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) > 0
  } catch (err) {
    if (isSegmentUniqueViolation(err)) return false
    throw err
  }
}
