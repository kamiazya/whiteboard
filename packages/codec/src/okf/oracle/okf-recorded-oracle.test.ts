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
 * moves an answer must say so by editing the recording by hand.
 *
 * Message text is not recorded: the Rust port words its refusals in its own
 * types, so the two agree on the stage, the class and, for a schema refusal,
 * each Zod issue's path and code.
 */
const FILE = new URL('./okf.jsonl', import.meta.url)

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

  it('equals what the core answers through the shim', () => {
    const parted = recorded.findIndex((c) => JSON.stringify(answerAgain(c)) !== JSON.stringify(c))
    expect(parted, 'the first recorded case the core no longer answers as recorded').toBe(-1)
  })
})
