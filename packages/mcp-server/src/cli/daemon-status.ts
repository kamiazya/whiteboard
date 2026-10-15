import { type DaemonRecordParseResult, parseDaemonRecord } from '../daemon/daemon-record.js'
import {
  type DaemonStatusResult,
  daemonStatusResultSchema,
} from '../shared/api-contracts/daemon-status.js'
import { isPidAlive as defaultIsPidAlive } from '../shared/process-alive.js'
import { readProcessStartMs, recordedProcessOf } from '../shared/process-identity.js'

export interface DaemonStatusOptions {
  dataDir: string
  parseRecord?: (dataDir: string) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
  /** When a pid's process started; null where the platform cannot say. */
  processStartMs?: (pid: number) => number | null
}

const recordSummary = ({ pid, version, startedAt }: NonNullable<DaemonStatusResult['record']>) => ({
  pid,
  version,
  startedAt,
})

export async function runDaemonStatus(
  options: DaemonStatusOptions,
): Promise<{ result: DaemonStatusResult; exitCode: 0 | 1 }> {
  const parse = options.parseRecord ?? parseDaemonRecord
  const isAlive = options.isPidAlive ?? defaultIsPidAlive

  const parsed = await parse(options.dataDir)

  if (parsed.kind === 'missing') {
    return {
      result: daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        reason: 'record-not-found',
        recordFound: false,
        recordFresh: false,
      }),
      exitCode: 1,
    }
  }

  if (parsed.kind === 'malformed') {
    return {
      result: daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        reason: 'record-malformed',
        recordFound: true,
        recordFresh: false,
      }),
      exitCode: 1,
    }
  }

  if (parsed.kind === 'token-missing') {
    return {
      result: daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        reason: 'record-token-missing',
        recordFound: true,
        recordFresh: false,
        record: recordSummary(parsed.record),
      }),
      exitCode: 1,
    }
  }

  // A pid a later process took after the daemon died is alive, and not it.
  const startMs = options.processStartMs ?? readProcessStartMs
  const identity = recordedProcessOf(parsed.record, { isAlive, startMs })

  if (identity !== 'writer') {
    return {
      result: daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        reason: identity === 'dead' ? 'process-not-running' : 'pid-reused',
        recordFound: true,
        recordFresh: false,
        pidAlive: identity !== 'dead',
        record: recordSummary(parsed.record),
      }),
      exitCode: 1,
    }
  }

  return {
    result: daemonStatusResultSchema.parse({
      schemaVersion: 1,
      ok: true,
      reason: null,
      recordFound: true,
      recordFresh: true,
      pidAlive: true,
      record: recordSummary(parsed.record),
    }),
    exitCode: 0,
  }
}
