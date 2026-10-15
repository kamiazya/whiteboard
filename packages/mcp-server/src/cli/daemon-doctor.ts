import {
  type DaemonLiveness,
  type DaemonLivenessSeams,
  daemonLiveness,
} from '../daemon/daemon-liveness.js'
import {
  type DaemonRecordParseResult,
  isOccupying,
  type OccupyingLiveness,
  parseDaemonRecord,
} from '../daemon/daemon-record.js'
import { describeDaemonVersionSkew } from '../daemon/version-skew.js'
import {
  type DaemonDoctorCheck,
  type DaemonDoctorResult,
  daemonDoctorResultSchema,
} from '../shared/api-contracts/daemon-doctor.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'

export interface DaemonDoctorOptions {
  dataDir: string
  parseRecord?: (dataDir: string, seams?: DaemonLivenessSeams) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
  /** When a pid's process started; null where the platform cannot say. */
  processStartMs?: (pid: number) => number | null
  runningVersion?: string
}

/** Where a daemon whose record cannot be used is still to be found. */
function stillServing(liveness: OccupyingLiveness, pid: number): string {
  if (liveness.state === 'running') return `the daemon it names (pid ${pid}) is still running`
  const serving = liveness.servingPid === undefined ? '' : ` (pid ${liveness.servingPid})`
  return `a daemon answers on the socket it names${serving}`
}

function unusableRecordCheck(
  parsed: Exclude<DaemonRecordParseResult, { kind: 'valid' }>,
): DaemonDoctorCheck {
  switch (parsed.kind) {
    case 'missing':
      return {
        id: 'daemon.record',
        status: 'error',
        summary: 'Daemon record not found.',
        remediation: 'Start the daemon with: whiteboard daemon run',
      }
    case 'malformed':
      return {
        id: 'daemon.record',
        status: 'error',
        summary: 'Daemon record is malformed.',
        remediation: 'Remove the daemon record and restart: whiteboard daemon run',
      }
    case 'token-missing':
      // `daemon run` refuses over a record whose daemon is still there, so a
      // restart is only the remedy once it is gone.
      if (isOccupying(parsed.liveness)) {
        return {
          id: 'daemon.record',
          status: 'error',
          summary: `Daemon record has no token, and ${stillServing(parsed.liveness, parsed.record.pid)}.`,
          remediation:
            'Stop that daemon with the build that started it (this record cannot reach it), then start the daemon: whiteboard daemon run',
        }
      }
      return {
        id: 'daemon.record',
        status: 'error',
        summary: 'Daemon record is present but has no token.',
        remediation: 'Restart the daemon: whiteboard daemon run',
      }
    case 'uninterpretable': {
      const { recorded } = parsed
      const version = recorded.version === undefined ? '' : ` It names version ${recorded.version}.`
      return {
        id: 'daemon.record',
        status: 'error',
        summary: `Daemon record cannot be interpreted by this version, and ${stillServing(parsed.liveness, recorded.pid)}.${version}`,
        remediation:
          'A daemon of another version is likeliest: stop it with that version, then start this one: whiteboard daemon run',
      }
    }
  }
}

// Summaries name no path: the support bundle embeds them and refuses one.
function processCheck(liveness: DaemonLiveness, pid: number): DaemonDoctorCheck {
  switch (liveness.state) {
    case 'running':
      return { id: 'daemon.process', status: 'ok', summary: 'Daemon process is running.' }
    case 'dead':
      return {
        id: 'daemon.process',
        status: 'error',
        summary: 'Daemon process is not running.',
        remediation: 'Start the daemon: whiteboard daemon run',
      }
    case 'pid-reused':
      return {
        id: 'daemon.process',
        status: 'error',
        summary: `Daemon process is not running (pid ${pid} now belongs to another process).`,
        remediation: 'Start the daemon: whiteboard daemon run',
      }
    case 'unconfirmed':
      return {
        id: 'daemon.process',
        status: 'error',
        summary:
          liveness.servingPid === undefined
            ? `A daemon answers on the recorded socket, but not as pid ${pid}, which the record names.`
            : `A daemon answers on the recorded socket as pid ${liveness.servingPid}, not as pid ${pid}, which the record names.`,
        remediation:
          'Stop the process serving the socket named in daemon.json, then start the daemon: whiteboard daemon run',
      }
  }
}

export async function runDaemonDoctor(
  options: DaemonDoctorOptions,
): Promise<{ result: DaemonDoctorResult; exitCode: 0 | 1 }> {
  const parse = options.parseRecord ?? parseDaemonRecord

  const checks: DaemonDoctorCheck[] = []
  const errorResult = (): { result: DaemonDoctorResult; exitCode: 1 } => ({
    result: daemonDoctorResultSchema.parse({
      schemaVersion: 1,
      ok: false,
      status: 'error',
      checks,
    }),
    exitCode: 1,
  })
  const seams = { isAlive: options.isPidAlive, startMs: options.processStartMs }
  const parsed = await parse(options.dataDir, seams)

  if (parsed.kind !== 'valid') {
    checks.push(unusableRecordCheck(parsed))
    return errorResult()
  }

  const liveness = await daemonLiveness(parsed.record, seams)
  const alive = liveness.state === 'running'

  checks.push({
    id: 'daemon.record',
    status: 'ok',
    summary: 'Daemon record found and valid.',
  })

  checks.push(processCheck(liveness, parsed.record.pid))

  const skew = describeDaemonVersionSkew(
    parsed.record.version,
    options.runningVersion ?? PACKAGE_VERSION,
  )
  if (skew !== null) {
    checks.push({
      id: 'daemon.version',
      status: 'warning',
      summary: `Daemon and CLI are different versions: ${skew}.`,
      remediation:
        'Stop the daemon with: whiteboard daemon stop --json, then start it from the build you ' +
        'intend to keep using. Two builds sharing a data directory can migrate it beneath each other.',
    })
  }

  return {
    result: daemonDoctorResultSchema.parse({
      schemaVersion: 1,
      ok: alive,
      status: !alive ? 'error' : skew === null ? 'ok' : 'warning',
      checks,
    }),
    exitCode: alive ? 0 : 1,
  }
}
