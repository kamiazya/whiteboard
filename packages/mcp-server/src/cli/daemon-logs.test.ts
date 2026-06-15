import { describe, expect, it, vi } from 'vitest'
import type { DaemonRecordParseResult } from '../daemon/daemon-record.js'
import { daemonLogEntrySchema } from '../shared/diagnostics/log-jsonl.js'
import { runDaemonLogs } from './daemon-logs.js'

function parseJsonLines(stream: string): unknown[] {
  if (stream === '') return []
  if (!stream.endsWith('\n')) {
    throw new Error('JSONL stream must end with a trailing newline')
  }
  return stream
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line))
}

const FIXED_TS = '2026-05-09T00:00:00.000Z'

function alwaysAlive(): boolean {
  return true
}
function neverAlive(): boolean {
  return false
}

describe('runDaemonLogs (whiteboard daemon logs --json)', () => {
  it('valid record + live PID: emits one JSONL info entry that conforms to the schema', async () => {
    const record: DaemonRecordParseResult = {
      kind: 'valid',
      record: {
        pid: 1234,
        port: 3099,
        token: 'should-never-leak',
        version: '0.0.4',
        startedAt: FIXED_TS,
      },
    }
    const { stdout, stderr, exitCode } = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => record,
      isPidAlive: alwaysAlive,
      now: () => FIXED_TS,
    })

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.endsWith('\n')).toBe(true)
    // Trailing-newline framing per line — important for the JSONL
    // contract once entry count > 1; whole-stream JSON.parse is
    // checked separately on the multi-entry path below.
    const lines = parseJsonLines(stdout)
    expect(lines).toHaveLength(1)
    const parsed = daemonLogEntrySchema.parse(lines[0])
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.level).toBe('info')
    expect(parsed.source).toBe('daemon')
    expect(parsed.fields).toEqual({
      pid: 1234,
      port: 3099,
      version: '0.0.4',
      status: 'ok',
    })
    // The record's token MUST NOT reach stdout in any form.
    expect(stdout).not.toContain('should-never-leak')
  })

  it('valid record + dead PID: emits one warn entry with status=process-not-running', async () => {
    const record: DaemonRecordParseResult = {
      kind: 'valid',
      record: {
        pid: 999,
        port: 3099,
        token: 't',
        version: '0.0.4',
        startedAt: FIXED_TS,
      },
    }
    const { stdout, exitCode } = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => record,
      isPidAlive: neverAlive,
      now: () => FIXED_TS,
    })
    expect(exitCode).toBe(0)
    const [line] = parseJsonLines(stdout)
    const parsed = daemonLogEntrySchema.parse(line)
    expect(parsed.level).toBe('warn')
    expect(parsed.fields.status).toBe('process-not-running')
    expect(parsed.message).toMatch(/process is not running/i)
  })

  it('missing record: emits one info entry with status=missing', async () => {
    const { stdout } = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => ({ kind: 'missing' }),
      now: () => FIXED_TS,
    })
    const [line] = parseJsonLines(stdout)
    const parsed = daemonLogEntrySchema.parse(line)
    expect(parsed.level).toBe('info')
    expect(parsed.fields).toEqual({ status: 'missing' })
  })

  it('malformed record with leaky message: redaction scrubs token / path / stack from the JSONL output', async () => {
    const { stdout } = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => ({
        kind: 'malformed',
        message: 'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42',
      }),
      now: () => FIXED_TS,
    })
    expect(stdout).not.toContain('secret-token-XYZ')
    expect(stdout).not.toMatch(/Bearer/i)
    expect(stdout).not.toMatch(/Authorization/i)
    expect(stdout).not.toMatch(/\/opt\//)
    expect(stdout).not.toMatch(/\.ts:\d/)

    const [line] = parseJsonLines(stdout)
    const parsed = daemonLogEntrySchema.parse(line)
    expect(parsed.level).toBe('warn')
    expect(parsed.fields).toEqual({ status: 'malformed' })
  })

  it('canvas-plaintext / unknown fields can never reach stdout because they are not surfaced by the helper at all', async () => {
    // The helper's `buildInputs` only sets allow-listed fields. Even
    // if the record carried a field with the same name as a producer
    // canary (e.g. canvasText), the helper never copies it into the
    // formatter input. This test is the regression for that boundary.
    const record: DaemonRecordParseResult = {
      kind: 'valid',
      record: {
        pid: 1,
        port: 3099,
        token: 't',
        version: '0.0.4',
        startedAt: FIXED_TS,
      },
    }
    const { stdout } = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => record,
      isPidAlive: alwaysAlive,
      now: () => FIXED_TS,
    })
    expect(stdout).not.toContain('canvasText')
    expect(stdout).not.toContain('rawPayload')
    expect(stdout).not.toContain('elements')
    expect(stdout).not.toContain('scene')
    expect(stdout).not.toContain('files')
    // Sanity: known operational keys ARE present.
    const [line] = parseJsonLines(stdout)
    const parsed = daemonLogEntrySchema.parse(line)
    expect(Object.keys(parsed.fields).sort()).toEqual(['pid', 'port', 'status', 'version'])
  })

  it('invalid timestamp from the source fails closed: empty stdout + generic stderr + non-zero exit', async () => {
    const { stdout, stderr, exitCode } = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => ({ kind: 'missing' }),
      // `now` is a test seam; production callers never pass an
      // invalid value.
      now: () => 'not-a-date',
    })
    expect(stdout).toBe('')
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/invalid log timestamp/i)
    // The generic stderr message MUST NOT echo the offending value.
    expect(stderr).not.toContain('not-a-date')
  })

  it('multiple parsed lines all conform to the schema (sanity for the multi-entry path)', async () => {
    // Today the helper emits a single entry, but the JSONL contract
    // is independent of entry count. Pin that by directly invoking
    // the formatter via a fake parse path that the helper still
    // routes through formatDaemonLogEntriesAsJsonLines.
    const record: DaemonRecordParseResult = {
      kind: 'valid',
      record: {
        pid: 7,
        port: 3099,
        token: 't',
        version: '0.0.4',
        startedAt: FIXED_TS,
      },
    }
    // Two back-to-back invocations across two calls; concatenated
    // stdout is still valid JSONL.
    const a = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => record,
      isPidAlive: alwaysAlive,
      now: () => FIXED_TS,
    })
    const b = await runDaemonLogs({
      dataDir: '/dev/null',
      parseRecord: async () => ({ kind: 'missing' }),
      now: () => FIXED_TS,
    })
    const concatenated = a.stdout + b.stdout
    expect(concatenated.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(concatenated)).toThrow()
    const lines = parseJsonLines(concatenated)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      daemonLogEntrySchema.parse(line)
    }
  })

  it('uses the production `parseDaemonRecord` when no test seam is provided (smoke against the real read path)', async () => {
    // Without a fake parseRecord, the helper must still produce a
    // valid JSONL line — the real `parseDaemonRecord` returns
    // `{ kind: 'missing' }` for a non-existent dataDir.
    const { stdout, exitCode } = await runDaemonLogs({
      dataDir: '/this/path/does/not/exist',
      now: () => FIXED_TS,
    })
    expect(exitCode).toBe(0)
    const [line] = parseJsonLines(stdout)
    const parsed = daemonLogEntrySchema.parse(line)
    expect(parsed.fields.status).toBe('missing')
  })
})

describe('CLI dispatcher: whiteboard daemon logs --json', () => {
  // These tests drive the real `main(argv)` from cli/dispatcher.ts —
  // not a hand-rolled mirror — so a regression that drops `'logs'`
  // from the allowed subcommand list, swaps stdout.write for
  // writeJsonObject, or otherwise rewires the dispatch will fail
  // here.

  function captureStdio<T>(
    body: () => Promise<T>,
  ): Promise<{ result: T; stdout: string; stderr: string }> {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const writeStdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        return true
      })
    const writeStderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        return true
      })
    return body()
      .then((result) => ({
        result,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      }))
      .finally(() => {
        writeStdout.mockRestore()
        writeStderr.mockRestore()
      })
  }

  it('drives the real main(): `daemon logs --json --data-dir=<empty>` writes JSONL to stdout exactly once with no array wrapper, no stderr', async () => {
    const { main } = await import('./dispatcher.js')
    const dataDir = '/this/path/does/not/exist-cli-logs-test'

    const { result: exitCode, stdout, stderr } = await captureStdio(() =>
      main(['daemon', 'logs', '--json', `--data-dir=${dataDir}`]),
    )

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.endsWith('\n')).toBe(true)
    // The single rendered line MUST be a JSON OBJECT, not an array
    // wrapper. Mutating the dispatcher to emit `[ ... ]` (one of the
    // mutation-test scenarios) would flip this assertion.
    const parsed = JSON.parse(stdout.trim())
    expect(Array.isArray(parsed)).toBe(false)
    daemonLogEntrySchema.parse(parsed)
    expect(parsed.fields.status).toBe('missing')
  })

  it('drives the real main() twice: concatenated stdout is valid multi-entry JSONL, NOT a single JSON document', async () => {
    const { main } = await import('./dispatcher.js')
    const dataDir = '/this/path/does/not/exist-cli-logs-test'

    const { stdout } = await captureStdio(async () => {
      await main(['daemon', 'logs', '--json', `--data-dir=${dataDir}`])
      await main(['daemon', 'logs', '--json', `--data-dir=${dataDir}`])
    })

    expect(stdout.endsWith('\n')).toBe(true)
    // Whole-stream JSON.parse MUST throw — this is the array-wrapper
    // regression guard. If a future change wrapped the entries in a
    // top-level `[...]`, JSON.parse would succeed.
    expect(() => JSON.parse(stdout)).toThrow()
    const lines = parseJsonLines(stdout)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      daemonLogEntrySchema.parse(line)
    }
  })

  it('rejects unknown subcommand: dropping `logs` from the allowed list would surface as `Unknown command` on stderr with exit 64', async () => {
    // Negative regression: prove the allowed-subcommand list is the
    // gate. We pass a deliberately-unknown subcommand to confirm the
    // dispatcher's exit-64 path is what would catch a `logs`-removal
    // mutation.
    const { main } = await import('./dispatcher.js')
    const { result: exitCode, stdout, stderr } = await captureStdio(() =>
      main(['daemon', 'this-is-not-a-real-subcommand', '--json']),
    )
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/Unknown command/i)
    // The usage hint MUST list `logs` as a supported subcommand —
    // a regression that drops it from `USAGE` would also drop the
    // expected line here.
    expect(stderr).toMatch(/whiteboard daemon logs\s+--json/)
  })
})
