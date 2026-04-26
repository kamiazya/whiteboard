import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { getDb } from '../store/db/index.js'
import { prepareDataDir } from '../store/db/prepare.js'

export const CURRENT_WORKSPACE_FILENAME = '.current-workspace'
export const LATEST_SESSION_FILENAME = '.latest-session'

async function readMarker(dataDir: string, fileName: string): Promise<string | null> {
  try {
    const candidate = (await readFile(join(dataDir, fileName), 'utf-8')).trim()
    return candidate.length > 0 ? candidate : null
  } catch {
    return null
  }
}

// Filesystem-only readers / writers kept around for the v0 importer's bridge
// path and any standalone tooling that operates on the legacy marker files
// directly. After the importer runs, the live source of truth is the
// `runtime` table inside whiteboard.db.
export async function resolveWorkspaceId(dataDir: string): Promise<string> {
  const current = await readMarker(dataDir, CURRENT_WORKSPACE_FILENAME)
  if (current) return current

  const legacy = await readMarker(dataDir, LATEST_SESSION_FILENAME)
  if (legacy) return legacy

  return nanoid()
}

export async function saveCurrentWorkspaceId(dataDir: string, workspaceId: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, CURRENT_WORKSPACE_FILENAME), workspaceId)
  await writeFile(join(dataDir, LATEST_SESSION_FILENAME), workspaceId)
}

// Memoize the workspace-id lookup per DATA_DIR. The first caller pays for the
// schema migration, the v0 importer, and the runtime table read; later callers
// share that promise and never round-trip to disk again.
const ensureCache = new Map<string, Promise<string>>()

export function ensureWorkspaceId(dataDir: string): Promise<string> {
  const existing = ensureCache.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
    // prepareDataDir runs schema migrations and the v0 importer. The importer
    // consumes any pre-existing .current-workspace marker and writes it into
    // the runtime table, so the DB is the live source of truth from this
    // point on.
    await prepareDataDir(dataDir)
    const db = await getDb(dataDir)

    const row = await db
      .selectFrom('runtime')
      .select(['value'])
      .where('key', '=', 'currentWorkspaceId')
      .executeTakeFirst()
    if (row?.value) {
      return row.value
    }

    // Fresh install — no v0 marker, no runtime row yet. Pick a new id and
    // upsert atomically so concurrent ensureWorkspaceId callers across worker
    // threads cannot diverge.
    const id = nanoid()
    const now = Date.now()
    await db
      .insertInto('runtime')
      .values({ key: 'currentWorkspaceId', value: id, updatedAt: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ updatedAt: now }))
      .execute()
    // After the upsert the canonical value is whatever already-existing row
    // won the race (or our id, when there was none); read it back to be sure.
    const settled = await db
      .selectFrom('runtime')
      .select(['value'])
      .where('key', '=', 'currentWorkspaceId')
      .executeTakeFirst()
    return settled?.value ?? id
  })()
  ensureCache.set(dataDir, pending)
  pending.catch(() => {
    // Drop the failed entry so a later call can retry instead of re-throwing
    // the original error forever.
    if (ensureCache.get(dataDir) === pending) {
      ensureCache.delete(dataDir)
    }
  })
  return pending
}

export function clearWorkspaceIdCache(): void {
  ensureCache.clear()
}
