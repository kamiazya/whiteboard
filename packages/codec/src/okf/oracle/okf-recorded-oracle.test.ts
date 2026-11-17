import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  answerAgain,
  decodeRecording,
  type ReaderCase,
  type WriterCase,
} from '../../test-utils/okf-oracle/oracle.js'

/**
 * The committed recording of the OKF envelope's answers, which the Rust crate
 * replays natively (`crates/core/codec/tests/okf_oracle.rs`), equals what the
 * core answers through its wasm shim. The recording was taken from the
 * TypeScript envelope before it was deleted and is frozen: it holds the inputs
 * as well as the answers, so this test needs no generator, and a change that
 * moves an answer must say so by editing the recording by hand, or, for an
 * answer that recorded a bug, by naming the case in `CORRECTED_WRITES`.
 *
 * Message text is not recorded: the Rust port words its refusals in its own
 * types, so the two agree on the stage, the class and, for a schema refusal,
 * each Zod issue's path and code.
 */
const FILE = new URL('./okf.jsonl', import.meta.url)

type Refusal = Extract<ReaderCase, { err: unknown }>['err']

/**
 * Writer cases whose recorded text is a `yaml` 2.9 bug the core no longer
 * reproduces: a first line that starts with a space, folded at a space where
 * a reader keeps the line break. The core writes it literal instead. The
 * native replay, `okf_oracle.rs`, admits a moved write only when the recorded
 * frontmatter does not read back to the document's strings and the new one
 * does, and pins the count; this pins which case it is.
 */
const CORRECTED_WRITES = new Set([1536])

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

  it('equals what the core answers through the shim', () => {
    const parted = recorded
      .map((c, index) => ({ index, again: answerAgain(c), c }))
      .filter(({ again, c }) => JSON.stringify(again) !== JSON.stringify(c))
    const moved = parted.filter(({ index }) => !CORRECTED_WRITES.has(index))
    expect(
      moved.map(({ index }) => index),
      'recorded cases the core no longer answers as recorded',
    ).toEqual([])
    // Each corrected write still differs, and only in the text written.
    expect(parted.map(({ index }) => index)).toEqual([...CORRECTED_WRITES])
    for (const { again, c } of parted) {
      expect({ ...again, y: undefined }, 'a corrected write moves only its text').toEqual({
        ...c,
        y: undefined,
      })
    }
  })
})
