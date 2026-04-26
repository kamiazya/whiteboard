import type { Database } from './index.js'

// Upsert helpers for the FK targets that downstream stores write to. Each one
// is a no-op when the row already exists; the displayName / pin fields are
// left untouched so a name set elsewhere does not get clobbered by a follow-up
// child write.

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

export async function upsertCanvasRow(
  db: Database,
  workspaceId: string,
  slug: string,
): Promise<void> {
  const now = Date.now()
  await upsertWorkspaceRow(db, workspaceId)
  await db
    .insertInto('canvases')
    .values({
      workspaceId,
      slug,
      displayName: null,
      isPinned: 0,
      pinOrder: null,
      currentBranch: 'main',
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc.columns(['workspaceId', 'slug']).doNothing())
    .execute()
}
