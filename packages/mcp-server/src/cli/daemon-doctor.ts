import {
  type DaemonRecordParseResult,
  isPidAlive as defaultIsPidAlive,
  parseDaemonRecord,
} from '../daemon/daemon-record.js'
import {
  type DaemonDoctorCheck,
  type DaemonDoctorResult,
  daemonDoctorResultSchema,
} from '../shared/api-contracts/daemon-doctor.js'

export interface DaemonDoctorOptions {
  dataDir: string
  parseRecord?: (dataDir: string) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
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

  if (parsed.kind === 'missing') {
    checks.push({
      id: 'daemon.record',
      status: 'error',
      summary: 'Daemon record not found.',
      remediation: 'Start the daemon with: whiteboard daemon run --json',
    })
    return errorResult()
  }

  if (parsed.kind === 'malformed') {
    checks.push({
      id: 'daemon.record',
      status: 'error',
      summary: 'Daemon record is malformed.',
      remediation: 'Remove the daemon record and restart: whiteboard daemon run --json',
    })
    return errorResult()
  }

  if (parsed.kind === 'token-missing') {
    checks.push({
      id: 'daemon.record',
      status: 'error',
      summary: 'Daemon record is present but has no token.',
      remediation: 'Restart the daemon: whiteboard daemon run --json',
    })
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

  return {
    result: daemonDoctorResultSchema.parse({
      schemaVersion: 1,
      ok: alive,
      status: alive ? 'ok' : 'error',
      checks,
    }),
    exitCode: alive ? 0 : 1,
  }
}
