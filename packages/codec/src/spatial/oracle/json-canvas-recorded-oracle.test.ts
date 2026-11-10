import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readerCases, writerCases } from '../../test-utils/json-canvas-oracle/corpus.js'
import {
  answerAgain,
  decodeRecording,
  encodeRecording,
  type Issues,
  type ReaderCase,
  type WriterCase,
} from '../../test-utils/json-canvas-oracle/oracle.js'

/**
 * The committed recording of the TypeScript's JSON Canvas answers equals what
 * the TypeScript answers today. The Rust crate replays that recording natively
 * (`crates/core/codec/tests/json_canvas_oracle.rs`), so `parseSpatial` and
 * `serializeSpatial`'s port is judged by this one, and cargo-mutants and the
 * coverage floor judge it by the same oracle; a recording left behind a
 * TypeScript change would judge it against an answer nobody gives.
 *
 * The recording holds the inputs, not just the answers, so this test asks the
 * TypeScript the same questions again and needs no generator. Re-record after a
 * deliberate change to the parser, the projection or the serialiser with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project codec-node json-canvas-recorded-oracle`.
 *
 * Message text is not recorded: the Rust port words its refusals in its own
 * types, so the two agree on the stage and, for a schema refusal, each Zod
 * issue's path and code.
 */
const FILE = new URL('./json-canvas.jsonl', import.meta.url)

const READER_CASES = 1400
const WRITER_CASES = 600

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeRecording([...readerCases(READER_CASES), ...writerCases(WRITER_CASES)]))
}

describe('the recorded JSON Canvas oracle', () => {
  const recorded = decodeRecording(readFileSync(FILE, 'utf8'))
  const readers = recorded.filter((c): c is ReaderCase => c.k === 'r')
  const writers = recorded.filter((c): c is WriterCase => c.k === 'w')

  it('reaches the answers the Rust port is held to', () => {
    const schema = readers.flatMap((c) =>
      'err' in c && 'issues' in c.err ? [c.err.issues as Issues] : [],
    )
    const codes = new Set(schema.flatMap((issues) => issues.map(([, code]) => code)))
    for (const code of [
      'invalid_type',
      'too_small',
      'too_big',
      'invalid_format',
      'invalid_value',
      'invalid_union',
      'custom',
    ]) {
      expect(codes.has(code), `an issue coded ${code}`).toBe(true)
    }
    expect(readers.filter((c) => 'ok' in c).length, 'accepted documents').toBeGreaterThan(400)
    expect(schema.length, 'documents refused by the schema').toBeGreaterThan(300)
    const stage = (name: string) => readers.filter((c) => 'err' in c && c.err.stage === name)
    expect(stage('json-syntax').length, 'texts that are not JSON').toBeGreaterThan(40)
    expect(
      readers.filter((c) => 'err' in c && 'class' in c.err && c.err.class === 'conversation')
        .length,
      'files carrying comments',
    ).toBeGreaterThan(3)
    const accepted = (needle: string) =>
      readers.filter((c) => 'ok' in c && JSON.stringify(c.ok).includes(needle)).length
    for (const needle of [
      '"lines"',
      '"embed"',
      '"bends"',
      '"facets"',
      '"tags"',
      '"backgroundStyle"',
    ]) {
      expect(accepted(needle), `accepted documents with ${needle}`).toBeGreaterThan(20)
    }
    expect(writers.filter((c) => 'y' in c).length, 'written canvases').toBeGreaterThan(400)
    expect(
      writers.filter((c) => 'err' in c).length,
      'canvases the strict mode refuses',
    ).toBeGreaterThan(40)
    expect(writers.filter((c) => c.m === 'strict').length, 'strict writes').toBeGreaterThan(250)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = recorded.findIndex((c) => JSON.stringify(answerAgain(c)) !== JSON.stringify(c))
    expect(parted, 'the first recorded case the TypeScript no longer answers as recorded').toBe(-1)
  })
})
