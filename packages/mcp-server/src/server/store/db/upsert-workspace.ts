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

// Look up the stable canvas id for (workspaceId, path). Returns null when
// the canvas does not exist.
export async function getDocumentIdByPath(
  db: Database,
  workspaceId: string,
  path: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('documents')
    .select(['id'])
    .where('workspaceId', '=', workspaceId)
    .where('path', '=', path)
    .executeTakeFirst()
  return row?.id ?? null
}

/** Thrown by metadata writers handed a path no document lives at. Routes map
 *  it to 404. */
export class DocumentNotFoundError extends Error {
  constructor(workspaceId: string, path: string) {
    super(`No document at "${workspaceId}/${path}".`)
    this.name = 'DocumentNotFoundError'
  }
}
