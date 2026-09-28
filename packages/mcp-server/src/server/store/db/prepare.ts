import { moveLegacyDataDirUnderTenant } from '../../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../../tenant/id.js'
import { getRawDb } from './index.js'
import { runMigrations } from './migrator.js'

// Memoized startup hook. Idempotent across repeated calls per dataDir, so
// daemon entry, createApp, smoke tests, and unit tests can all call it
// without coordinating who runs the migrations first.
const ready = new Map<string, Promise<void>>()

export function prepareDataDir(dataDir: string): Promise<void> {
  const existing = ready.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
    const db = await getRawDb(dataDir)
    await runMigrations(db)
    // AFTER the database migrations: 0008 and 0012 rewrite file names under
    // the pre-tenant layout, so the directories have to still be where those
    // migrations left them when they run.
    await moveLegacyDataDirUnderTenant(dataDir, SELF_HOST_TENANT_ID)
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
