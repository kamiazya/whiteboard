/**
 * `redactDaemonLogEntry` claims, in a comment, that its output "matches
 * `daemonLogEntrySchema`" — a claim no test asserted, over an input type
 * whose `fields` is a free record. The reader on the other side of stdout
 * parses each line with that schema, so a producer input the helper turns
 * into an unparseable line is a log entry that never arrives.
 */
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  type DaemonLogEntryInput,
  daemonLogEntrySchema,
  formatDaemonLogEntriesAsJsonLines,
  formatDaemonLogEntryAsJsonLine,
  redactDaemonLogEntry,
} from './log-jsonl.js'

const LEVELS = daemonLogEntrySchema.shape.level.options
const SOURCES = daemonLogEntrySchema.shape.source.options

const ALLOWED = ['checkId', 'remediationId', 'status', 'code', 'version', 'platform', 'pid', 'port']
const DENIED = ['canvasText', 'elements', 'rawPayload', 'requestHeaders', 'authorization', 'token']

/** ISO 8601 with a `Z` or an offset, with and without milliseconds, as the producers write it. */
const timestampArb = fc
  .tuple(
    fc.date({ min: new Date(0), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true }),
    fc.constantFrom('Z', '+09:00', '-05:30'),
    fc.boolean(),
  )
  .map(([date, offset, millis]) => {
    const iso = date.toISOString()
    const base = millis ? iso.slice(0, -1) : iso.slice(0, 19)
    return `${base}${offset}`
  })

/** Text that carries what the redactor exists for, at real weight. */
const textArb = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: fc.string({ maxLength: 12 }) },
      { weight: 1, arbitrary: fc.constant('Authorization: Bearer abc.def-123') },
      { weight: 1, arbitrary: fc.constant('Bearer tok_1') },
      { weight: 1, arbitrary: fc.constant('/Users/me/wb/secret.db') },
    ),
    { maxLength: 4 },
  )
  .map((parts) => parts.join(' '))

const keyArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...ALLOWED) },
  { weight: 1, arbitrary: fc.constantFrom(...DENIED) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 8 }) },
)

const valueArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: textArb },
  { weight: 3, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.bigInt() },
  { weight: 1, arbitrary: fc.constant(() => 'fn') },
  { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY) },
)

const inputArb: fc.Arbitrary<DaemonLogEntryInput> = fc.record(
  {
    timestamp: timestampArb,
    level: fc.constantFrom(...LEVELS),
    source: fc.constantFrom(...SOURCES),
    message: textArb,
    fields: fc.dictionary(keyArb, valueArb, { maxKeys: 6 }),
  },
  { requiredKeys: ['level', 'source', 'message'] },
)

const BEARER_WITH_TOKEN = /Bearer\s+\S/
const UNIX_PATH = /\/[A-Za-z_][A-Za-z0-9_\-/.]+/

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) strings(v, out)
  }
  return out
}

describe('a redacted daemon log entry is one its reader parses', () => {
  fcTest.prop([inputArb], withDefaults())(
    'the entry matches the schema and its line parses back equal',
    (input) => {
      const entry = redactDaemonLogEntry(input)
      const parsed = daemonLogEntrySchema.safeParse(entry)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      const line = formatDaemonLogEntryAsJsonLine(input)
      expect(line.endsWith('\n')).toBe(true)
      expect(daemonLogEntrySchema.parse(JSON.parse(line))).toEqual(
        JSON.parse(JSON.stringify(entry)),
      )
    },
  )

  fcTest.prop([inputArb], withDefaults())(
    'only allow-listed fields survive, and no token or path does',
    (input) => {
      const entry = redactDaemonLogEntry(input)
      for (const key of Object.keys(entry.fields)) {
        expect(ALLOWED, key).toContain(key)
        expect(DENIED, key).not.toContain(key)
      }
      for (const text of strings(entry)) {
        expect(text, text).not.toMatch(BEARER_WITH_TOKEN)
        expect(text, text).not.toMatch(UNIX_PATH)
      }
    },
  )

  fcTest.prop([fc.array(inputArb, { maxLength: 5 })], withDefaults({ numRuns: 60 }))(
    'a stream is the concatenation of its lines',
    (inputs) => {
      const stream = formatDaemonLogEntriesAsJsonLines(inputs)
      expect(stream).toBe(inputs.map((input) => formatDaemonLogEntryAsJsonLine(input)).join(''))
    },
  )
})
