import { DATA_DIR } from '../config.js'
import { validateWorkspaceId } from '../validators.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { type InstalledLibrariesResponse } from '../../shared/api-contracts/libraries.js'

// Persist the list of installed .excalidrawlib URLs per workspace, backed by
// the installed_libraries table. URLs are returned in installation order via
// installedAt to keep the UI display order stable.

export type { InstalledLibrariesResponse }

async function dbReady() {
  await prepareDataDir(DATA_DIR)
  return getDb(DATA_DIR)
}

export async function loadInstalledLibraries(
  workspaceId: string,
): Promise<InstalledLibrariesResponse> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const rows = await db
    .selectFrom('installed_libraries')
    .select(['url'])
    .where('workspaceId', '=', workspaceId)
    .orderBy('installedAt', 'asc')
    .execute()
  return { urls: rows.map((r) => r.url) }
}

export async function saveInstalledLibraries(
  workspaceId: string,
  libs: InstalledLibrariesResponse,
): Promise<void> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  await upsertWorkspaceRow(db, workspaceId)
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('installed_libraries').where('workspaceId', '=', workspaceId).execute()
    if (libs.urls.length === 0) return
    const now = Date.now()
    // Slot the timestamp by index so installedAt reflects the input order.
    await trx
      .insertInto('installed_libraries')
      .values(
        libs.urls.map((url, index) => ({
          workspaceId,
          url,
          installedAt: now + index,
        })),
      )
      .execute()
  })
}

export async function addInstalledLibrary(
  workspaceId: string,
  url: string,
): Promise<InstalledLibrariesResponse> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  await upsertWorkspaceRow(db, workspaceId)
  await db
    .insertInto('installed_libraries')
    .values({ workspaceId, url, installedAt: Date.now() })
    .onConflict((oc) => oc.columns(['workspaceId', 'url']).doNothing())
    .execute()
  return loadInstalledLibraries(workspaceId)
}

export async function removeInstalledLibrary(
  workspaceId: string,
  url: string,
): Promise<InstalledLibrariesResponse> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  await db
    .deleteFrom('installed_libraries')
    .where('workspaceId', '=', workspaceId)
    .where('url', '=', url)
    .execute()
  return loadInstalledLibraries(workspaceId)
}
