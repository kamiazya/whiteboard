import {
  type DaemonLivenessSeams,
  daemonLiveness,
  servingPidOf,
} from '../daemon/daemon-liveness.js'
import {
  type DaemonRecordParseResult,
  isOccupying,
  parseDaemonRecord,
} from '../daemon/daemon-record.js'
import {
  type DaemonStatusResult,
  daemonStatusResultSchema,
} from '../shared/api-contracts/daemon-status.js'

export interface DaemonStatusOptions {
  dataDir: string
  parseRecord?: (dataDir: string, seams?: DaemonLivenessSeams) => Promise<DaemonRecordParseResult>
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

type StatusFields = Omit<DaemonStatusResult, 'schemaVersion' | 'ok' | 'recordFound'>

/** What a record no daemon can be asked through says, `recordFound` aside. */
function unusableRecord(
  parsed: Exclude<DaemonRecordParseResult, { kind: 'valid' | 'missing' | 'unreadable' }>,
): StatusFields {
  switch (parsed.kind) {
    case 'malformed':
      return { reason: 'record-malformed', recordFresh: false }
    case 'token-missing':
      return {
        reason: 'record-token-missing',
        recordFresh: false,
        pidAlive: isOccupying(parsed.liveness),
        ...servingPidOf(parsed.liveness),
        record: recordSummary(parsed.record),
      }
    // A record this build cannot interpret, whose daemon is still there:
    // likeliest another version's, and never to be reported as a leftover.
    case 'uninterpretable': {
      const { pid, version, startedAt } = parsed.recorded
      return {
        reason: 'record-other-version',
        recordFresh: false,
        pidAlive: true,
        ...servingPidOf(parsed.liveness),
        ...(version === undefined || startedAt === undefined
          ? {}
          : { record: { pid, version, startedAt } }),
      }
    }
  }
}

export async function runDaemonStatus(
  options: DaemonStatusOptions,
): Promise<{ result: DaemonStatusResult; exitCode: 0 | 1 }> {
  const parse = options.parseRecord ?? parseDaemonRecord
  const seams = { isAlive: options.isPidAlive, startMs: options.processStartMs }
  const parsed = await parse(options.dataDir, seams)
  const answer = (exitCode: 0 | 1, recordFound: boolean, fields: StatusFields) => ({
    result: daemonStatusResultSchema.parse({
      schemaVersion: 1,
      ok: exitCode === 0,
      recordFound,
      ...fields,
    }),
    exitCode,
  })

  if (parsed.kind === 'missing') {
    return answer(1, false, { reason: 'record-not-found', recordFresh: false })
  }
  if (parsed.kind === 'unreadable') {
    return answer(1, parsed.recordFound, { reason: 'record-unreadable', recordFresh: false })
  }
  if (parsed.kind !== 'valid') return answer(1, true, unusableRecord(parsed))

  const liveness = await daemonLiveness(parsed.record, seams)
  if (liveness.state !== 'running') {
    return answer(1, true, {
      reason: STATUS_REASON[liveness.state],
      recordFresh: false,
      pidAlive: isOccupying(liveness),
      ...servingPidOf(liveness),
      record: recordSummary(parsed.record),
    })
  }
  return answer(0, true, {
    reason: null,
    recordFresh: true,
    pidAlive: true,
    record: recordSummary(parsed.record),
  })
}
