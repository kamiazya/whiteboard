import { type DaemonRecordParseResult, parseDaemonRecord } from '../daemon/daemon-record.js'
import { describeDaemonVersionSkew } from '../daemon/version-skew.js'
import {
  type DaemonDoctorCheck,
  type DaemonDoctorResult,
  daemonDoctorResultSchema,
} from '../shared/api-contracts/daemon-doctor.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { isPidAlive as defaultIsPidAlive } from '../shared/process-alive.js'

export interface DaemonDoctorOptions {
  dataDir: string
  parseRecord?: (dataDir: string) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
  runningVersion?: string
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
        remediation: 'Start the daemon with: whiteboard daemon run --json',
      }
    case 'malformed':
      return {
        id: 'daemon.record',
        status: 'error',
        summary: 'Daemon record is malformed.',
        remediation: 'Remove the daemon record and restart: whiteboard daemon run --json',
      }
    case 'token-missing':
      return {
        id: 'daemon.record',
        status: 'error',
        summary: 'Daemon record is present but has no token.',
        remediation: 'Restart the daemon: whiteboard daemon run --json',
      }
  }
}

export async function runDaemonDoctor(
  options: DaemonDoctorOptions,
): Promise<{ result: DaemonDoctorResult; exitCode: 0 | 1 }> {
  const parse = options.parseRecord ?? parseDaemonRecord
  const isAlive = options.isPidAlive ?? defaultIsPidAlive

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
  const parsed = await parse(options.dataDir)

  if (parsed.kind !== 'valid') {
    checks.push(unusableRecordCheck(parsed))
    return errorResult()
  }

  const alive = isAlive(parsed.record.pid)

  checks.push({
    id: 'daemon.record',
    status: 'ok',
    summary: 'Daemon record found and valid.',
  })

  checks.push({
    id: 'daemon.process',
    status: alive ? 'ok' : 'error',
    summary: alive ? 'Daemon process is running.' : 'Daemon process is not running.',
    remediation: alive ? undefined : 'Start the daemon: whiteboard daemon run --json',
  })

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
