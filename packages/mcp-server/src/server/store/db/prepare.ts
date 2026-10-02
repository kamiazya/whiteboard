import { fileURLToPath } from 'node:url'
import { parseDaemonRecord } from '../../../daemon/daemon-record.js'
import { describeDaemonVersionSkew } from '../../../daemon/version-skew.js'
import { PACKAGE_VERSION } from '../../../shared/package-version.js'
import { isPidAlive } from '../../../shared/process-alive.js'
import { getLogger } from '../../log.js'
import { moveLegacyDataDirUnderTenant } from '../../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../../tenant/id.js'
import { getRawDb } from './index.js'
import { resolveDatabaseLocation } from './location.js'
import { runMigrations } from './migrator.js'

const log = getLogger('prepare-data-dir')

// Where the database actually is, for an error a person has to act on: the
// file in the data directory by default, else the configured URL without the
// credentials or query a URL may carry (the auth token is a separate setting).
function describeDatabase(dataDir: string): string {
  const { url } = resolveDatabaseLocation(dataDir)
  if (url.startsWith('file:')) {
    try {
      return fileURLToPath(url)
    } catch {
      return url
    }
  }
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

// Migrations run in-process on whichever build starts first, so a build that
// migrates under a live daemon of another version changes the schema beneath
// it. Startup is not blocked: the two can be compatible, and refusing would
// strand a user whose old daemon they cannot easily stop. A record whose
// process is gone, or is this process, is a leftover rather than a neighbour.
async function warnOnDaemonVersionSkew(dataDir: string): Promise<void> {
  try {
    const parsed = await parseDaemonRecord(dataDir)
    if (parsed.kind !== 'valid' && parsed.kind !== 'token-missing') return
    const { pid, version } = parsed.record
    if (pid === process.pid || !isPidAlive(pid)) return
    const skew = describeDaemonVersionSkew(version, PACKAGE_VERSION)
    if (skew === null) return
    log.warning(
      { dataDir, pid, recordedVersion: version, runningVersion: PACKAGE_VERSION },
      `${skew}; migrating in-process may change the schema under it. Restart that daemon on the same version.`,
    )
  } catch {
    // Advisory only: an unreadable record must not cost the startup.
  }
}

// Memoized startup hook. Idempotent across repeated calls per dataDir, so
// daemon entry, createApp, smoke tests, and unit tests can all call it
// without coordinating who runs the migrations first.
const ready = new Map<string, Promise<void>>()

export function prepareDataDir(dataDir: string): Promise<void> {
  const existing = ready.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
    const db = await getRawDb(dataDir)
    await warnOnDaemonVersionSkew(dataDir)
    await runMigrations(db, describeDatabase(dataDir))
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
