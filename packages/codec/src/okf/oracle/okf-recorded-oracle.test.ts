import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readerCases, writerCases } from '../../test-utils/okf-oracle/corpus.js'
import {
  answerAgain,
  decodeRecording,
  encodeRecording,
  type ReaderCase,
  type WriterCase,
} from '../../test-utils/okf-oracle/oracle.js'

/**
 * The committed recording of the TypeScript's OKF envelope answers equals what
 * the TypeScript answers today. The Rust crate replays that recording natively
 * (`crates/core/codec/tests/okf_oracle.rs`), so `parseOkf`'s port is judged by
 * this one, and cargo-mutants and the coverage floor judge it by the same
 * oracle; a recording left behind a TypeScript change would judge it against an
 * answer nobody gives.
 *
 * The recording holds the inputs, not just the answers, so this test asks the
 * TypeScript the same questions again and needs no generator. Re-record after
 * a deliberate change to the parser or the serialiser with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project codec-node okf-recorded-oracle`.
 *
 * Message text is not recorded: the Rust port words its refusals in its own
 * types, so the two agree on the stage, the class and, for a schema refusal,
 * each Zod issue's path and code.
 */
const FILE = new URL('./okf.jsonl', import.meta.url)

const READER_CASES = 1200
const WRITER_CASES = 500

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeRecording([...readerCases(READER_CASES), ...writerCases(WRITER_CASES)]))
}

type Refusal = Extract<ReaderCase, { err: unknown }>['err']

describe('the recorded OKF envelope oracle', () => {
  const recorded = decodeRecording(readFileSync(FILE, 'utf8'))
  const readers = recorded.filter((c): c is ReaderCase => c.k === 'r')
  const writers = recorded.filter((c): c is WriterCase => c.k === 'w')

  it('reaches the answers the Rust port is held to', () => {
    const refused = (pick: (err: Refusal) => boolean) =>
      readers.filter((c) => 'err' in c && pick(c.err)).length
    const accepted = (pick: (text: string) => boolean) =>
      readers.filter((c) => 'ok' in c && pick(JSON.stringify(c.ok))).length
    expect(readers.filter((c) => 'ok' in c).length, 'accepted documents').toBeGreaterThan(250)
    for (const cls of ['anchor', 'depth', 'subset', 'syntax']) {
      expect(
        refused((e) => e.stage === 'yaml' && e.class === cls),
        `documents refused at the YAML as ${cls}`,
      ).toBeGreaterThan(3)
    }
    for (const cls of ['nofence', 'reserved', 'schema']) {
      expect(
        refused((e) => e.stage === 'frontmatter-schema' && e.class === cls),
        `documents refused by the schema as ${cls}`,
      ).toBeGreaterThan(8)
    }
    expect(
      accepted((ok) => ok.includes('"facetsRaw"')),
      'documents with facetsRaw',
    ).toBeGreaterThan(20)
    expect(
      accepted((ok) => ok.includes('"verified"')),
      'documents with verified',
    ).toBeGreaterThan(20)
    expect(
      accepted((ok) => ok.includes('"generated"')),
      'documents with generated',
    ).toBeGreaterThan(20)
    expect(
      accepted((ok) => ok.includes('"facets",')),
      'documents with facets',
    ).toBeGreaterThan(20)
    expect(writers.filter((c) => 'y' in c).length, 'written documents').toBeGreaterThan(350)
    expect(writers.filter((c) => 'err' in c).length, 'unwritable documents').toBeGreaterThan(20)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = recorded.findIndex((c) => JSON.stringify(answerAgain(c)) !== JSON.stringify(c))
    expect(parted, 'the first recorded case the TypeScript no longer answers as recorded').toBe(-1)
  })
})
