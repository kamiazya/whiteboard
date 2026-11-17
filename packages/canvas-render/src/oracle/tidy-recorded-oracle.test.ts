import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeLines, encodeLines } from '../test-utils/render-oracle/oracle.js'
import {
  answerOf,
  drawingCases,
  META,
  type OracleRecord,
  recording,
  type TidyCase,
} from '../test-utils/tidy-oracle/oracle.js'

/**
 * The committed recording of what `tidyNodes` answers, over the drawing corpus,
 * the calls the package's own tidy suites make, the ceilings and seeded boards;
 * the Rust port replays it exactly (`tests/tidy_oracle.rs` in
 * `crates/core/canvas-render`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node tidy-recorded`.
 */
const FILE = new URL('./tidy.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeLines(recording()))
}

type Case = OracleRecord & TidyCase & { readonly m: readonly (readonly [string, ...number[]])[] }

describe('the recorded tidy oracle', () => {
  const recorded = decodeLines<OracleRecord>(readFileSync(FILE, 'utf8'))
  const cases = recorded.filter((r): r is Case => r.k !== 'meta') as Case[]

  it('reaches every rule the function branches on', () => {
    const count = (keep: (c: Case) => boolean) => cases.filter(keep).length
    expect(recorded.filter((r) => r.k === 'meta')).toEqual([{ k: 'meta', ...META }])
    expect(count((c) => c.k === 'seeded')).toBe(META.boards)
    expect(count((c) => c.k === 'drawing')).toBe(drawingCases().length)
    expect(count((c) => c.k === 'test')).toBeGreaterThan(900)
    expect(count((c) => c.k === 'extra')).toBeGreaterThan(8)
    expect(
      count((c) => c.m.length > 0),
      'boards tidy moves',
    ).toBeGreaterThan(1200)
    expect(
      count((c) => c.m.length === 0),
      'boards already tidy',
    ).toBeGreaterThan(60)
    expect(
      count((c) => c.m.some((m) => m.length === 5)),
      'a frame that grew',
    ).toBeGreaterThan(200)
    expect(
      count((c) => c.nodes.some((n) => n[1] === 1)),
      'boards with a frame',
    ).toBeGreaterThan(500)
    expect(
      count((c) => c.scope !== undefined),
      'scoped',
    ).toBeGreaterThan(200)
    expect(
      count((c) => (c.locked?.length ?? 0) > 0),
      'with a lock',
    ).toBeGreaterThan(200)
    expect(
      count((c) => (c.edges?.length ?? 0) > 0),
      'with edges',
    ).toBeGreaterThan(300)
    expect(
      count((c) => c.nodes.some((n) => n.slice(2).some((v) => typeof v === 'string'))),
      'with a non-finite number',
    ).toBeGreaterThan(20)
  })

  it('equals what the TypeScript answers for every case today', () => {
    const stale = cases.find((c) => JSON.stringify(answerOf(c)) !== JSON.stringify(c.m))
    expect(stale?.id, 'the first case the TypeScript no longer answers as recorded').toBeUndefined()
  })

  it('records the same inputs the generators draw today', () => {
    const fresh = recording()
    expect(fresh.length).toBe(recorded.length)
    const drifted = fresh.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(recorded[i]))
    expect(drifted, 'the first record whose input or answer drifted').toBe(-1)
  })
})
