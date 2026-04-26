import type { Database } from './index.js'

// Some store operations (palette_set, library install, …) target a workspace
// that may not yet have a canvas. The workspaces table is FK'd from those
// child tables, so insert a placeholder row if needed before writing the
// child row. The row is harmless: it represents the workspace as currently
// known to the daemon, with no displayName.
export async function upsertWorkspaceRow(
  db: Database,
  workspaceId: string,
): Promise<void> {
  const now = Date.now()
  await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      displayName: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
}
