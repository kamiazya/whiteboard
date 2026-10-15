import { daemonLiveness } from '../daemon/daemon-liveness.js'
import { type DaemonRecordParseResult, parseDaemonRecord } from '../daemon/daemon-record.js'
import {
  type DaemonStatusResult,
  daemonStatusResultSchema,
} from '../shared/api-contracts/daemon-status.js'

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

const STATUS_REASON = {
  dead: 'process-not-running',
  'pid-reused': 'pid-reused',
  unconfirmed: 'identity-unconfirmed',
} as const

export async function runDaemonStatus(
  options: DaemonStatusOptions,
): Promise<{ result: DaemonStatusResult; exitCode: 0 | 1 }> {
  const parse = options.parseRecord ?? parseDaemonRecord

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

  const liveness = await daemonLiveness(parsed.record, {
    isAlive: options.isPidAlive,
    startMs: options.processStartMs,
  })

  if (liveness !== 'running') {
    return {
      result: daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        reason: STATUS_REASON[liveness],
        recordFound: true,
        recordFresh: false,
        pidAlive: liveness !== 'dead',
        ...(liveness === 'unconfirmed' ? { pingOk: true } : {}),
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
