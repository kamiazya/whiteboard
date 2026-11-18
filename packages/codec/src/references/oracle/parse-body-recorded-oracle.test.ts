import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The committed recording of what `resolveReferences(parseMarkdownBody(t))`
 * answered; the Rust port replays it
 * (`crates/core/codec/tests/parse_body_oracle.rs`). The recording is frozen,
 * with no writer, since the TypeScript it was recorded from is gone; what is
 * checked here is what it covers.
 */
const FILE = new URL('./parse-body.jsonl', import.meta.url)

type Meta = { kind: 'meta' }
type Case = { i: string; t: string; h: string; n: string; m?: unknown; u?: unknown }

describe('the recorded parse-body oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
  const cases = recorded
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Meta | Case)
    .filter((line): line is Case => !('kind' in line))

  it('reaches the reference grammar from every place a body holds text', () => {
    const resolved = (c: Case): string => JSON.stringify(c.m ?? '')
    expect(cases.filter((c) => resolved(c).includes('"wikiLink"')).length).toBeGreaterThan(40)
    expect(cases.filter((c) => resolved(c).includes('"embed"')).length).toBeGreaterThan(15)
    expect(cases.filter((c) => c.h !== c.n).length).toBeGreaterThan(400)
  })
})
