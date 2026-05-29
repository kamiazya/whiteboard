import { describe, expect, it } from 'vitest'
import {
  type DaemonLogEntry,
  type DaemonLogEntryInput,
  InvalidLogTimestampError,
  daemonLogEntrySchema,
  formatDaemonLogEntriesAsJsonLines,
  formatDaemonLogEntryAsJsonLine,
  redactDaemonLogEntry,
} from './log-jsonl.js'

function parseJsonLines(stream: string): unknown[] {
  if (stream === '') return []
  if (!stream.endsWith('\n')) {
    throw new Error('JSONL stream must end with a trailing newline')
  }
  // Drop the trailing newline before splitting; the final segment
  // would otherwise be an empty string.
  return stream
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line))
}

const baseInput: DaemonLogEntryInput = {
  timestamp: '2026-05-09T00:00:00.000Z',
  level: 'info',
  source: 'daemon',
  message: 'startup ok',
  fields: { pid: 1234, port: 3099, status: 'ok' },
}

describe('daemon JSONL log surface', () => {
  it('formats N entries as N independently parseable JSON lines plus a trailing newline', () => {
    const entries: DaemonLogEntryInput[] = [
      { ...baseInput, message: 'a' },
      { ...baseInput, message: 'b', level: 'warn' },
      { ...baseInput, message: 'c', source: 'doctor' },
    ]
    const stream = formatDaemonLogEntriesAsJsonLines(entries)

    expect(stream.endsWith('\n')).toBe(true)
    // Each entry contributes exactly one '\n' — no array wrapper, no
    // double-newlines.
    expect(stream.split('\n').filter((line) => line.length > 0)).toHaveLength(entries.length)

    const lines = parseJsonLines(stream)
    expect(lines).toHaveLength(entries.length)
    for (const line of lines) {
      const parsed = daemonLogEntrySchema.parse(line)
      expect(parsed.schemaVersion).toBe(1)
    }
    expect((lines[0] as DaemonLogEntry).message).toBe('a')
    expect((lines[1] as DaemonLogEntry).level).toBe('warn')
    expect((lines[2] as DaemonLogEntry).source).toBe('doctor')

    // Defence-in-depth: the whole stream must NOT be parseable as a
    // single JSON document. JSONL is the contract.
    expect(() => JSON.parse(stream)).toThrow()
  })

  it('empty input produces empty output (no spurious newline)', () => {
    expect(formatDaemonLogEntriesAsJsonLines([])).toBe('')
  })

  it('redacts message + nested field values: tokens, paths, stack frames become sentinels', () => {
    const stream = formatDaemonLogEntryAsJsonLine({
      timestamp: '2026-05-09T00:00:00.000Z',
      level: 'error',
      source: 'daemon',
      message: 'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42',
      fields: {
        // Allow-listed string with token-like content — sentinels.
        status: 'Authorization: Bearer secret-token-XYZ',
        // Allow-listed code carrying a Unix path.
        code: 'failed at /Users/me/whiteboard/data.db',
      },
    })
    const [line] = parseJsonLines(stream) as [DaemonLogEntry]
    daemonLogEntrySchema.parse(line)

    expect(line.message).not.toContain('secret-token-XYZ')
    expect(line.message).not.toMatch(/Bearer/i)
    expect(line.message).not.toMatch(/Authorization/i)
    expect(line.message).not.toMatch(/\/opt\//)
    expect(line.message).not.toMatch(/\.ts:\d/)

    expect(line.fields.status).not.toContain('secret-token-XYZ')
    expect(line.fields.status).not.toMatch(/Bearer/i)
    expect(line.fields.code).not.toMatch(/\/Users\//)
  })

  it('canvas-plaintext deny-list keeps user content out of fields, even when the producer tries to set them', () => {
    const stream = formatDaemonLogEntryAsJsonLine({
      timestamp: '2026-05-09T00:00:00.000Z',
      level: 'info',
      source: 'mcp',
      message: 'tick',
      fields: {
        canvasText: 'TOP_SECRET_CANVAS_TEXT',
        elementText: 'TOP_SECRET_CANVAS_TEXT',
        scene: { elements: [{ text: 'TOP_SECRET_CANVAS_TEXT' }] },
        elements: [{ text: 'TOP_SECRET_CANVAS_TEXT' }],
        files: { 'fid-1': 'TOP_SECRET_CANVAS_TEXT' },
        rawPayload: 'TOP_SECRET_CANVAS_TEXT',
        requestHeaders: { authorization: 'Bearer secret-token-XYZ' },
        authorization: 'Bearer secret-token-XYZ',
        token: 'secret-token-XYZ',
        // Allow-listed operational fields survive.
        pid: 1234,
        port: 3099,
        status: 'ok',
      },
    })
    expect(stream).not.toContain('TOP_SECRET_CANVAS_TEXT')
    expect(stream).not.toContain('secret-token-XYZ')

    const [line] = parseJsonLines(stream) as [DaemonLogEntry]
    expect(line.fields).toEqual({ pid: 1234, port: 3099, status: 'ok' })
    // Deny-listed keys must NOT appear at all (not even with a redacted value).
    expect(Object.keys(line.fields)).not.toContain('canvasText')
    expect(Object.keys(line.fields)).not.toContain('rawPayload')
    expect(Object.keys(line.fields)).not.toContain('authorization')
  })

  it('drops unknown (non-allow-listed) fields silently', () => {
    const stream = formatDaemonLogEntryAsJsonLine({
      ...baseInput,
      fields: { pid: 1, somethingUnknown: 'should-not-appear', anotherUnknown: 42 },
    })
    const [line] = parseJsonLines(stream) as [DaemonLogEntry]
    expect(line.fields).toEqual({ pid: 1 })
  })

  it('schema sanity: literal schemaVersion=1, level/source enums, fields object', () => {
    const out = redactDaemonLogEntry(baseInput)
    daemonLogEntrySchema.parse(out)
    expect(out.schemaVersion).toBe(1)

    // schemaVersion=2 must not parse against today's schema — anyone
    // bumping it must update consumers in lockstep.
    expect(() =>
      daemonLogEntrySchema.parse({ ...out, schemaVersion: 2 } as unknown),
    ).toThrow()
    // Unknown level / source rejected.
    expect(() => daemonLogEntrySchema.parse({ ...out, level: 'trace' } as unknown)).toThrow()
    expect(() =>
      daemonLogEntrySchema.parse({ ...out, source: 'unrelated' } as unknown),
    ).toThrow()
  })

  it('handles 1,000 entries: same number of lines, trailing newline, line-by-line parseable', () => {
    const entries: DaemonLogEntryInput[] = Array.from({ length: 1000 }, (_, i) => ({
      ...baseInput,
      message: `tick-${i}`,
      fields: { pid: i, status: 'ok' },
    }))
    const stream = formatDaemonLogEntriesAsJsonLines(entries)
    expect(stream.endsWith('\n')).toBe(true)
    const lines = parseJsonLines(stream)
    expect(lines).toHaveLength(1000)
    expect((lines[0] as DaemonLogEntry).message).toBe('tick-0')
    expect((lines[999] as DaemonLogEntry).message).toBe('tick-999')
    // Whole-stream JSON.parse must still fail — JSONL is preserved
    // even at scale.
    expect(() => JSON.parse(stream)).toThrow()
  })

  it('rejects an invalid timestamp at the redactor boundary (fail-closed) and at the schema layer', () => {
    // Producer-side: passing a non-ISO timestamp into the redactor
    // throws — never silently emits a malformed log line that a
    // downstream collector would have to defend against.
    expect(() =>
      redactDaemonLogEntry({
        ...baseInput,
        timestamp: 'not-a-date',
      }),
    ).toThrow(InvalidLogTimestampError)

    // Regex-passing but logically invalid (month 13 / day 40) must
    // also fail closed — `Date.parse` returns NaN here.
    expect(() =>
      redactDaemonLogEntry({
        ...baseInput,
        timestamp: '2026-13-40T00:00:00Z',
      }),
    ).toThrow(InvalidLogTimestampError)

    // Schema-side: anyone constructing a `DaemonLogEntry` directly
    // (e.g. a future support-bundle assembler that builds entries
    // outside this helper) must not be able to slip a non-ISO
    // timestamp past the JSONL contract either.
    expect(() =>
      daemonLogEntrySchema.parse({
        schemaVersion: 1,
        timestamp: 'not-a-date',
        level: 'info',
        source: 'daemon',
        message: 'msg',
        fields: {},
      }),
    ).toThrow()

    // Offset-less ISO is also rejected (the contract is "with
    // timezone offset" — `Z` or `±HH:MM`).
    expect(() =>
      daemonLogEntrySchema.parse({
        schemaVersion: 1,
        timestamp: '2026-05-09T00:00:00',
        level: 'info',
        source: 'daemon',
        message: 'msg',
        fields: {},
      }),
    ).toThrow()
  })

  it('accepts the valid ISO 8601 forms the contract documents', () => {
    for (const ts of [
      '2026-05-09T00:00:00Z',
      '2026-05-09T00:00:00.123Z',
      '2026-05-09T00:00:00+09:00',
      '2026-05-09T00:00:00.456-05:00',
    ]) {
      const out = redactDaemonLogEntry({ ...baseInput, timestamp: ts })
      expect(out.timestamp).toBe(ts)
      daemonLogEntrySchema.parse(out)
    }
  })

  it('non-JSON-safe values (function / symbol / bigint) become sentinel strings instead of crashing JSON.stringify', () => {
    const stream = formatDaemonLogEntryAsJsonLine({
      ...baseInput,
      fields: {
        // Allow-listed key with a non-JSON-safe value — must round-trip.
        version: BigInt(42) as unknown as number,
      },
    })
    expect(() => parseJsonLines(stream)).not.toThrow()
    const [line] = parseJsonLines(stream) as [DaemonLogEntry]
    expect(typeof line.fields.version).toBe('string')
    expect(line.fields.version).toMatch(/REDACTED/i)
  })
})
