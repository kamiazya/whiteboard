import { nanoid } from 'nanoid'
import { getDb } from '../store/db/index.js'
import { prepareDataDir } from '../store/db/prepare.js'

// The current workspace id is the live source of truth in the `runtime`
// table. ensureWorkspaceId memoizes the lookup per dataDir; the first caller
// pays for migrations and the row read, later callers share the promise.
const ensureCache = new Map<string, Promise<string>>()

export function ensureWorkspaceId(dataDir: string): Promise<string> {
  const existing = ensureCache.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
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

    // Fresh install — no row yet. Pick a new id and upsert atomically so
    // concurrent ensureWorkspaceId callers across worker threads cannot
    // diverge on the chosen id.
    const id = nanoid()
    const now = Date.now()
    await db
      .insertInto('runtime')
      .values({ key: 'currentWorkspaceId', value: id, updatedAt: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ updatedAt: now }))
      .execute()
    // The conflict path leaves the existing value in place, so read it back
    // to return whichever id won the race.
    const settled = await db
      .selectFrom('runtime')
      .select(['value'])
      .where('key', '=', 'currentWorkspaceId')
      .executeTakeFirst()
    return settled?.value ?? id
  })()
  ensureCache.set(dataDir, pending)
  pending.catch(() => {
    if (ensureCache.get(dataDir) === pending) {
      ensureCache.delete(dataDir)
    }
  })
  return pending
}

export function clearWorkspaceIdCache(): void {
  ensureCache.clear()
}
