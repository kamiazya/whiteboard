import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Case, type Meta, record } from '../../test-utils/scan-oracle/oracle.js'

/**
 * The committed recording of what `scanReferences` and `findNextReference`
 * answer; the Rust scanner replays it
 * (`crates/core/codec/tests/scan_oracle.rs`). The recording was written from
 * the TypeScript scanner and is frozen, with no writer: the check that it
 * equals the TypeScript goes with the scanner.
 */
const FILE = new URL('./scan.jsonl', import.meta.url)

const lines = (records: readonly (Meta | Case)[]): string =>
  `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

describe('the recorded reference-scanner oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
  const cases = recorded
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Meta | Case)
    .filter((line): line is Case => !('kind' in line))
  const matches = cases.flatMap((c) => c.r)

  it('reaches every arm of the grammar and every way an opener fails to close', () => {
    expect(cases.length).toBeGreaterThan(1500)
    expect(cases.filter((c) => c.r.length === 0).length, 'no reference').toBeGreaterThan(100)
    expect(matches.filter((m) => m[2]).length, 'embeds').toBeGreaterThan(100)
    expect(matches.filter((m) => !m[2]).length, 'links').toBeGreaterThan(100)
    expect(matches.filter((m) => m[4] !== null).length, 'aliases').toBeGreaterThan(100)
    expect(matches.filter((m) => m[4] === '').length, 'empty aliases').toBeGreaterThan(0)
    expect(matches.filter((m) => m[5] !== null).length, 'fragments').toBeGreaterThan(50)
    expect(matches.filter((m) => m[5]?.includes('#')).length, 'fragments with a #').toBeGreaterThan(
      0,
    )
    expect(
      matches.filter((m) => /^\[\[[^\]|]*#\]\]$/.test(m[1])).length,
      'empty fragment',
    ).toBeGreaterThan(0)
    expect(matches.filter((m) => /[^\x20-\xff]/.test(m[1])).length, 'non-Latin').toBeGreaterThan(20)
    expect(matches.filter((m) => /[\ud800-\udbff]/.test(m[1])).length, 'astral').toBeGreaterThan(5)
    expect(cases.filter((c) => c.t.length > 10_000).length, 'long inputs').toBeGreaterThan(5)
    expect(cases.filter((c) => c.n !== undefined).length, 'cursor probes').toBeGreaterThan(700)
  })

  it('equals what the TypeScript scanner answers today (deleted with the scanner)', () => {
    expect(recorded).toBe(lines(record()))
  })
})
