import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readerCases, writerCases } from '../../test-utils/frontmatter-oracle/corpus.js'
import {
  answerAgain,
  decodeRecording,
  encodeRecording,
  type ReaderCase,
  type WriterCase,
} from '../../test-utils/frontmatter-oracle/oracle.js'

/**
 * The committed recording of the TypeScript's frontmatter answers equals what
 * the TypeScript answers today. The Rust crate replays that recording
 * natively (`crates/core/codec/tests/recorded_oracle.rs`), so the reader and
 * writer it ports are judged by this one, and cargo-mutants and the coverage
 * floor judge them by the same oracle; a recording left behind a TypeScript
 * change would judge them against an answer nobody gives.
 *
 * The recording holds the inputs, not just the answers: this test asks the
 * TypeScript the same questions again and needs no generator. Re-record after
 * a deliberate change to the reader or the writer with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project codec-node recorded-oracle`.
 */
// Kept in this package, not beside the Rust test: the Rust jobs' path scope
// covers the crate, so a re-recording runs both sides, while a crate change
// does not run this package's projects.
const FILE = new URL('./frontmatter.jsonl', import.meta.url)

const READER_CASES = 2600
const WRITER_CASES = 1000

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeRecording([...readerCases(READER_CASES), ...writerCases(WRITER_CASES)]))
}

describe('the recorded frontmatter oracle', () => {
  const recorded = decodeRecording(readFileSync(FILE, 'utf8'))
  const readers = recorded.filter((c): c is ReaderCase => c.k === 'r')
  const writers = recorded.filter((c): c is WriterCase => c.k === 'w')

  it('reaches the answers the Rust port is held to', () => {
    const refused = (cls: string) => readers.filter((c) => 'err' in c && c.err === cls).length
    expect(readers.filter((c) => 'ok' in c).length, 'accepted texts').toBeGreaterThan(1500)
    for (const cls of ['anchor', 'depth', 'subset', 'syntax']) {
      expect(refused(cls), `texts refused as ${cls}`).toBeGreaterThan(8)
    }
    expect(
      readers.filter((c) => /(^|\n)[ -]*[a-z0-9_]+: [|>]/.test(c.y)).length,
      'block scalars',
    ).toBeGreaterThan(100)
    expect(readers.filter((c) => /^\? /m.test(c.y)).length, 'explicit keys').toBeGreaterThan(5)
    expect(writers.filter((c) => 'y' in c).length, 'written values').toBeGreaterThan(900)
    expect(writers.filter((c) => 'err' in c).length, 'unwritable values').toBeGreaterThan(5)
    expect(
      writers.filter((c) => 'y' in c && /(^|\n)[ -]*[a-z0-9_]+: [|>]/.test(c.y)).length,
      'block scalars written',
    ).toBeGreaterThan(60)
    expect(
      writers.filter((c) => 'y' in c && /(^|\n) *\? /.test(c.y)).length,
      'explicit keys written',
    ).toBeGreaterThan(5)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = recorded.findIndex((c) => JSON.stringify(answerAgain(c)) !== JSON.stringify(c))
    expect(parted, 'the first recorded case the TypeScript no longer answers as recorded').toBe(-1)
  })
})
