import { getDb } from './index.js'
import { importV0Filesystem } from './import-v0-filesystem.js'
import { runMigrations } from './migrator.js'

const V0_IMPORTER_RUNTIME_KEY = 'v0ImporterCompletedAt'

// Memoized startup hook. Idempotent across repeated calls per dataDir, so
// daemon entry, createApp, smoke tests, and unit tests can all call it
// without coordinating who runs the migrations first.
const ready = new Map<string, Promise<void>>()

export function prepareDataDir(dataDir: string): Promise<void> {
  const existing = ready.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
    const db = await getDb(dataDir)
    await runMigrations(db)

    // Run the v0 importer at most once per dataDir lifetime. The marker is
    // recorded after a successful import so a second startup reads from the
    // already-populated tables instead of re-walking the filesystem on every
    // boot. Re-running an importer that has already moved files into
    // .legacy-bak/ is safe (the helper is idempotent), but the disk-walk cost
    // adds up on warm dirs.
    const marker = await db
      .selectFrom('runtime')
      .select(['value'])
      .where('key', '=', V0_IMPORTER_RUNTIME_KEY)
      .executeTakeFirst()
    if (!marker) {
      await importV0Filesystem({ db, dataDir })
      const now = Date.now()
      await db
        .insertInto('runtime')
        .values({
          key: V0_IMPORTER_RUNTIME_KEY,
          value: String(now),
          updatedAt: now,
        })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({ value: String(now), updatedAt: now }),
        )
        .execute()
    }
  })()
  ready.set(dataDir, pending)
  pending.catch(() => {
    // Allow retries on next call after a transient failure.
    if (ready.get(dataDir) === pending) {
      ready.delete(dataDir)
    }
  })
  return pending
}

export function clearPrepareCache(): void {
  ready.clear()
}
