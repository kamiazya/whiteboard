import { DATA_DIR } from '../config.js'
import { validateWorkspaceId } from '../validators.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'

async function dbReady() {
  await prepareDataDir(DATA_DIR)
  return getDb(DATA_DIR)
}

export async function loadPalette(workspaceId: string): Promise<Record<string, string>> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const rows = await db
    .selectFrom('palette')
    .select(['key', 'value'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  const out: Record<string, string> = {}
  for (const row of rows) out[row.key] = row.value
  return out
}

export async function mergePaletteEntries(
  workspaceId: string,
  entries: Record<string, string>,
): Promise<Record<string, string>> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  await upsertWorkspaceRow(db, workspaceId)
  await db.transaction().execute(async (trx) => {
    for (const [key, value] of Object.entries(entries)) {
      await trx
        .insertInto('palette')
        .values({ workspaceId, key, value })
        .onConflict((oc) =>
          oc.columns(['workspaceId', 'key']).doUpdateSet({ value }),
        )
        .execute()
    }
  })
  return loadPalette(workspaceId)
}

export async function deletePaletteEntries(
  workspaceId: string,
  keys: string[],
): Promise<Record<string, string>> {
  validateWorkspaceId(workspaceId)
  if (keys.length === 0) return loadPalette(workspaceId)
  const db = await dbReady()
  await db
    .deleteFrom('palette')
    .where('workspaceId', '=', workspaceId)
    .where('key', 'in', keys)
    .execute()
  return loadPalette(workspaceId)
}
