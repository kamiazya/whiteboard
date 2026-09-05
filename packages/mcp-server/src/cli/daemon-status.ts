import {
  type DaemonRecordParseResult,
  isPidAlive as defaultIsPidAlive,
  parseDaemonRecord,
} from '../daemon/daemon-record.js'
import {
  type DaemonStatusResult,
  daemonStatusResultSchema,
} from '../shared/api-contracts/daemon-status.js'

export interface DaemonStatusOptions {
  dataDir: string
  parseRecord?: (dataDir: string) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
}

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
        record: {
          pid: parsed.record.pid,
          port: parsed.record.port,
          version: parsed.record.version,
          startedAt: parsed.record.startedAt,
        },
      }),
      exitCode: 1,
    }
  }

  const alive = isAlive(parsed.record.pid)

  if (!alive) {
    return {
      result: daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        reason: 'process-not-running',
        recordFound: true,
        recordFresh: false,
        pidAlive: false,
        record: {
          pid: parsed.record.pid,
          port: parsed.record.port,
          version: parsed.record.version,
          startedAt: parsed.record.startedAt,
        },
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
      record: {
        pid: parsed.record.pid,
        port: parsed.record.port,
        version: parsed.record.version,
        startedAt: parsed.record.startedAt,
      },
    }),
    exitCode: 0,
  }
}
