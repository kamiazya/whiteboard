// Pure helper behind `whiteboard daemon logs --json`. The CLI layer
// is intentionally a thin shell over this function so tests can drive
// every branch (record missing / malformed / token-missing / pid
// dead / ok) without spawning a real daemon.
//
// The output contract is JSONL — newline-delimited JSON per entry,
// trailing newline at the end of the stream — produced through
// `formatDaemonLogEntriesAsJsonLines`. Going through the formatter
// is what gives us:
//   - schemaVersion=1 + schema validation
//   - operational-field allow-list (canvas plaintext can never reach
//     stdout even if a producer mistakenly sets it on a fields entry)
//   - sentinel scrub (Authorization / Bearer / token / path / stack)
//   - ISO timestamp normalisation (fail-closed on invalid input)
//
// stdout is reserved for JSONL or empty; diagnostics go to stderr via
// the `stderr` field of the returned outcome.

import {
  type DaemonRecordParseResult,
  isPidAlive as defaultIsPidAlive,
  parseDaemonRecord,
} from '../daemon/daemon-record.js'
import {
  type DaemonLogEntryInput,
  formatDaemonLogEntriesAsJsonLines,
  InvalidLogTimestampError,
} from '../shared/diagnostics/log-jsonl.js'

export interface DaemonLogsOptions {
  dataDir: string
  // Test seams. Production callers leave them undefined and get the
  // real implementations.
  parseRecord?: (dataDir: string) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
  now?: () => string
}

export interface DaemonLogsOutcome {
  // JSONL stream. Empty string when the formatter rejects an input
  // (e.g. invalid timestamp); never carries a partial JSONL line.
  stdout: string
  // Generic, sentinel-friendly diagnostic copy. Never echoes the
  // offending input value — keeping a fail-closed surface from
  // turning into a leak channel.
  stderr: string
  exitCode: number
}

function buildInputs(
  result: DaemonRecordParseResult,
  isAlive: (pid: number) => boolean,
  timestamp: string,
): DaemonLogEntryInput[] {
  switch (result.kind) {
    case 'missing':
      return [
        {
          timestamp,
          level: 'info',
          source: 'daemon',
          message: 'Daemon record not found.',
          fields: { status: 'missing' },
        },
      ]
    case 'malformed':
      // The parser's `message` field can carry diagnostic detail
      // (e.g. JSON parse errors). The formatter's redactor will
      // scrub anything path / token / stack-shaped before stdout.
      return [
        {
          timestamp,
          level: 'warn',
          source: 'daemon',
          message: `Daemon record malformed: ${result.message}`,
          fields: { status: 'malformed' },
        },
      ]
    case 'token-missing':
      return [
        {
          timestamp,
          level: 'warn',
          source: 'daemon',
          message: 'Daemon record present but has no token.',
          fields: {
            pid: result.record.pid,
            port: result.record.port,
            version: result.record.version,
            status: 'token-missing',
          },
        },
      ]
    case 'valid': {
      const alive = isAlive(result.record.pid)
      return [
        {
          timestamp,
          level: alive ? 'info' : 'warn',
          source: 'daemon',
          message: alive
            ? 'Daemon record present.'
            : 'Daemon record present but process is not running.',
          fields: {
            pid: result.record.pid,
            port: result.record.port,
            version: result.record.version,
            status: alive ? 'ok' : 'process-not-running',
          },
        },
      ]
    }
  }
}

export async function runDaemonLogs(options: DaemonLogsOptions): Promise<DaemonLogsOutcome> {
  const parse = options.parseRecord ?? parseDaemonRecord
  const isAlive = options.isPidAlive ?? defaultIsPidAlive
  const now = options.now ?? (() => new Date().toISOString())

  const result = await parse(options.dataDir)
  const inputs = buildInputs(result, isAlive, now())

  let stdout = ''
  try {
    stdout = formatDaemonLogEntriesAsJsonLines(inputs)
  } catch (err) {
    if (err instanceof InvalidLogTimestampError) {
      // Fail-closed: stdout stays empty (no partial JSONL line). The
      // stderr copy is intentionally generic — echoing the bad
      // timestamp would defeat the redaction layer below the helper.
      return {
        stdout: '',
        stderr: 'Invalid log timestamp.\n',
        exitCode: 1,
      }
    }
    throw err
  }
  return { stdout, stderr: '', exitCode: 0 }
}
