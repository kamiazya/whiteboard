import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Case, type Meta, record } from '../../test-utils/parse-body-oracle/oracle.js'

/**
 * The committed recording of what `resolveReferences(parseMarkdownBody(t))`
 * answers equals what it answers today; the Rust port replays it
 * (`crates/core/codec/tests/parse_body_oracle.rs`). Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project codec-node parse-body-recorded`.
 */
const FILE = new URL('./parse-body.jsonl', import.meta.url)

const lines = (records: readonly (Meta | Case)[]): string =>
  `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') writeFileSync(FILE, lines(record()))

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

  it('equals what the TypeScript answers today', { timeout: 120_000 }, () => {
    expect(recorded).toBe(lines(record()))
  })
})
