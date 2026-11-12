import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toWellFormed } from '../../test-utils/frontmatter-oracle/oracle.js'
import { generated } from '../../test-utils/mdast-oracle/corpus.js'
import {
  answer,
  type Case,
  isFrozen,
  type Meta,
  meta,
  record,
  withTree,
} from '../../test-utils/mdast-oracle/oracle.js'

/**
 * The committed recording of what `parseMarkdownBody` answers equals what it
 * answers today, and the Rust parser replays it
 * (`crates/core/markdown/tests/mdast_oracle.rs`), apart from the differences
 * that test's ledger tolerates. The repository documents and the spec
 * examples are frozen inputs, so editing a doc never moves this file; the
 * generated inputs are checked against their generator. Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project codec-node mdast-recorded`.
 */
const FILE = new URL('./mdast.jsonl', import.meta.url)

type Line = Meta | Case

const read = (): Line[] =>
  readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const frozen = read()
    .filter((l): l is Case => !('kind' in l) && isFrozen(l.i))
    .map(({ i, t }) => ({ i, t }))
  writeFileSync(
    FILE,
    `${record(frozen)
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
}

describe('the recorded mdast oracle', () => {
  const lines = read()
  const cases = lines.filter((l): l is Case => !('kind' in l))

  it('reaches every kind of input the Rust parser is held to', () => {
    const of = (prefix: RegExp) => cases.filter((c) => prefix.test(c.i)).length
    expect(of(/^md:/), 'repository documents').toBeGreaterThan(300)
    expect(of(/^okf/), 'OKF bodies').toBeGreaterThan(400)
    expect(of(/^cv/), 'canvas text nodes').toBeGreaterThan(100)
    expect(of(/^cm#/), 'CommonMark examples').toBe(652)
    expect(of(/^gfm#/), 'GFM extension examples').toBe(24)
    expect(of(/^r\d/), 'random token strings').toBe(meta().random)
    expect(of(/^f\d/), 'hostile families').toBeGreaterThan(300)
    expect(of(/^d\d/), 'wiki-link, embed and shortcode cases').toBeGreaterThan(30)
    expect(of(/^b\d/), 'inputs past a bound').toBeGreaterThan(4)
  })

  it('records the generated inputs the generator produces today', () => {
    const recorded = cases.filter((c) => !isFrozen(c.i)).map(({ i, t }) => ({ i, t }))
    expect(recorded.map((c) => c.i)).toEqual(generated().map((c) => c.i))
    const parted = generated().findIndex((c, n) => toWellFormed(c.t) !== recorded[n]?.t)
    expect(parted, 'the first generated input that is no longer recorded').toBe(-1)
  })

  it('equals what parseMarkdownBody answers today', { timeout: 300_000 }, () => {
    const parted = cases.find((c) => {
      const now = answer(c.t)
      return now.h !== c.h || (withTree(c.i) && JSON.stringify(now.tree) !== JSON.stringify(c.m))
    })
    expect(
      parted?.i,
      'the first recorded case the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })

  it('keeps the trees of the sets read by a person', () => {
    const shown = cases.filter((c) => withTree(c.i))
    expect(shown.length).toBeGreaterThan(700)
    expect(shown.every((c) => c.m !== undefined)).toBe(true)
  })
})
