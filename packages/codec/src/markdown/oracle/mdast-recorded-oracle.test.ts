import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The committed recording of what `parseMarkdownBody` answered, which the Rust
 * parser replays (`crates/core/markdown/tests/mdast_oracle.rs`), apart from the
 * differences that test's ledger tolerates. The recording is frozen: it has no
 * writer, since the TypeScript parser it was recorded from is gone, so editing
 * a document in the repository never moves it. What is checked here is what
 * it covers.
 */
const FILE = new URL('./mdast.jsonl', import.meta.url)

type Meta = { kind: 'meta'; seed: number; random: number; pastBound: string }
type Case = { i: string; t: string; h: string; l: number[]; x: string; m?: unknown }
type Line = Meta | Case

/** The sets whose trees are recorded in full: small, and read by a person. */
const withTree = (id: string): boolean => /^(cm#|gfm#|d\d)/.test(id)

const read = (): Line[] =>
  readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)

describe('the recorded mdast oracle', () => {
  const lines = read()
  const cases = lines.filter((l): l is Case => !('kind' in l))
  const random = lines.find((l): l is Meta => 'kind' in l)?.random

  it('reaches every kind of input the Rust parser is held to', () => {
    const of = (prefix: RegExp) => cases.filter((c) => prefix.test(c.i)).length
    expect(of(/^md:/), 'repository documents').toBeGreaterThan(300)
    expect(of(/^okf/), 'OKF bodies').toBeGreaterThan(400)
    expect(of(/^cv/), 'canvas text nodes').toBeGreaterThan(100)
    expect(of(/^cm#/), 'CommonMark examples').toBe(652)
    expect(of(/^gfm#/), 'GFM extension examples').toBe(24)
    expect(of(/^r\d/), 'random token strings').toBe(random)
    expect(of(/^f\d/), 'hostile families').toBeGreaterThan(300)
    expect(of(/^d\d/), 'wiki-link, embed and shortcode cases').toBeGreaterThan(30)
    expect(of(/^b\d/), 'inputs past a bound').toBeGreaterThan(4)
  })

  it("records a rail excerpt for every input, one line, and not merely the body's source", () => {
    expect(cases.every((c) => typeof c.x === 'string' && !/\s{2}|^\s|\s$/.test(c.x))).toBe(true)
    expect(cases.filter((c) => c.x !== '').length).toBeGreaterThan(5_000)
    expect(cases.filter((c) => c.x !== c.t.trim()).length).toBeGreaterThan(1_000)
  })

  it('keeps the trees of the sets read by a person', () => {
    const shown = cases.filter((c) => withTree(c.i))
    expect(shown.length).toBeGreaterThan(700)
    expect(shown.every((c) => c.m !== undefined)).toBe(true)
  })
})
