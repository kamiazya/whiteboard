import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Case, type Meta, record } from '../../test-utils/parse-body-oracle/oracle.js'

/**
 * The committed recording of what `resolveReferences(parseMarkdownBody(t))`
 * answers equals what it answers today; the Rust port replays it
 * (`crates/core/codec/tests/parse_body_oracle.rs`). The recording is frozen,
 * with no writer; the check that it equals the TypeScript goes with the
 * TypeScript parser.
 */
const FILE = new URL('./parse-body.jsonl', import.meta.url)

const lines = (records: readonly (Meta | Case)[]): string =>
  `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

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

  it('equals what the TypeScript answers today (deleted with the parser)', {
    timeout: 120_000,
  }, () => {
    expect(recorded).toBe(lines(record()))
  })
})
