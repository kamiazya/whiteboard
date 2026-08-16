import { nanoid } from 'nanoid'
import type { Database } from './index.js'

// Upsert helpers for the FK targets that downstream stores write to. Each one
// is a no-op when the row already exists; the displayName / pin fields are
// left untouched so a name set elsewhere does not get clobbered by a follow-up
// child write.

export async function upsertWorkspaceRow(db: Database, workspaceId: string): Promise<void> {
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

// Look up the stable canvas id for (workspaceId, slug). Returns null when
// the canvas does not exist; callers that want to create it should use
// upsertCanvasRow.
export async function getCanvasIdBySlug(
  db: Database,
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('documents')
    .select(['id'])
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .executeTakeFirst()
  return row?.id ?? null
}

// Look up or create the canvases row for (workspaceId, slug). Returns the
// stable canvas id child tables FK on. The displayName / pin fields are left
// at their existing values when the row already exists, matching the previous
// "upsert without overwriting names" semantics.
export async function upsertCanvasRow(
  db: Database,
  workspaceId: string,
  slug: string,
): Promise<string> {
  await upsertWorkspaceRow(db, workspaceId)
  const existing = await getCanvasIdBySlug(db, workspaceId, slug)
  if (existing) return existing
  const id = nanoid(12)
  const now = Date.now()
  await db
    .insertInto('documents')
    .values({
      id,
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
  // Re-read in case a concurrent insert won the race; otherwise our generated
  // id is the canonical one.
  const resolved = await getCanvasIdBySlug(db, workspaceId, slug)
  return resolved ?? id
}
