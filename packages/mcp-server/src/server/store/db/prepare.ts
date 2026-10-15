import { fileURLToPath } from 'node:url'
import {
  type DaemonLiveness,
  daemonLiveness,
  servingPidOf,
} from '../../../daemon/daemon-liveness.js'
import { isOccupying, parseDaemonRecord } from '../../../daemon/daemon-record.js'
import { describeDaemonVersionSkew } from '../../../daemon/version-skew.js'
import { PACKAGE_VERSION } from '../../../shared/package-version.js'
import { getLogger } from '../../log.js'
import { moveLegacyDataDirUnderTenant } from '../../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../../tenant/id.js'
import { getRawDb } from './index.js'
import { resolveDatabaseLocation } from './location.js'
import { withMigrationLock } from './migration-lock.js'
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
// process is gone, whose pid another process took, or that names this process
// is a leftover rather than a neighbour; one whose socket answers as another
// pid is not, since something still serves the data dir. A record this build
// cannot interpret is warned about whatever version it names: it is the
// likeliest to be another version's, and the record shape changing is itself
// a skew.
async function warnOnDaemonVersionSkew(dataDir: string): Promise<void> {
  try {
    const neighbour = await liveNeighbour(dataDir)
    if (neighbour === null || neighbour.pid === process.pid) return
    const { pid, version, uninterpretable, servingPid } = neighbour
    const skew = version === undefined ? null : describeDaemonVersionSkew(version, PACKAGE_VERSION)
    if (skew === null && !uninterpretable) return
    log.warning(
      {
        dataDir,
        pid,
        ...(servingPid === undefined ? {} : { servingPid }),
        recordedVersion: version ?? null,
        runningVersion: PACKAGE_VERSION,
      },
      `${skew ?? `daemon pid ${pid} wrote a record this build cannot interpret`}; migrating in-process may change the schema under it. Restart that daemon on the same version.`,
    )
  } catch {
    // Advisory only: an unreadable record must not cost the startup.
  }
}

interface Neighbour {
  pid: number
  version?: string
  uninterpretable: boolean
  /** The pid that answered on the record's socket, where it was not the record's. */
  servingPid?: number
}

function occupyingNeighbour(
  liveness: DaemonLiveness,
  neighbour: Omit<Neighbour, 'servingPid'>,
): Neighbour | null {
  return isOccupying(liveness) ? { ...neighbour, ...servingPidOf(liveness) } : null
}

/** The daemon the record names, when it may still be serving. */
async function liveNeighbour(dataDir: string): Promise<Neighbour | null> {
  const parsed = await parseDaemonRecord(dataDir)
  switch (parsed.kind) {
    case 'missing':
    case 'unreadable':
    case 'malformed':
      return null
    case 'uninterpretable': {
      const { pid, version } = parsed.recorded
      return occupyingNeighbour(parsed.liveness, { pid, version, uninterpretable: true })
    }
    case 'token-missing': {
      const { pid, version } = parsed.record
      return occupyingNeighbour(parsed.liveness, { pid, version, uninterpretable: false })
    }
    case 'valid': {
      const { pid, version } = parsed.record
      // Checked before liveness, so the common unskewed start asks no socket.
      if (pid === process.pid) return null
      if (describeDaemonVersionSkew(version, PACKAGE_VERSION) === null) return null
      const liveness = await daemonLiveness(parsed.record)
      return occupyingNeighbour(liveness, { pid, version, uninterpretable: false })
    }
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
    // Held across processes, not only this one: a second server opening the
    // same data dir waits here and then finds nothing pending.
    await withMigrationLock(dataDir, async () => {
      await runMigrations(db, describeDatabase(dataDir))
      // AFTER the database migrations: 0008 and 0012 rewrite file names under
      // the pre-tenant layout, so the directories have to still be where those
      // migrations left them when they run.
      await moveLegacyDataDirUnderTenant(dataDir, SELF_HOST_TENANT_ID)
    })
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
