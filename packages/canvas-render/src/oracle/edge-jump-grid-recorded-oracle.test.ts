import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type EdgeJumpGridRecord,
  edgeJumpGridRecords,
} from '../test-utils/edge-jump-grid-oracle/oracle.js'

/**
 * The committed recording of what the line-jump broad phase (`place` and
 * `SegmentGrid` in `layout/edges/edge-jumps.ts`) answers equals what it
 * answers today, and the Rust port replays it exactly
 * (`tests/edge_jump_grid_oracle.rs` in `crates/core/edge-routing`). Re-record
 * after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node edge-jump-grid-recorded`.
 */
const FILE = new URL('./edge-jump-grid.jsonl', import.meta.url)

const fresh = edgeJumpGridRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as EdgeJumpGridRecord)

const MAX_GRID_WORK_PER_SCENE = 4_000_000

describe('the recorded edge-jump grid oracle', () => {
  it('reaches every way the grid answers', () => {
    const steps = records.flatMap((r) => r.steps)
    const reaches = steps.flatMap((s) => s.reached.flatMap((r) => r ?? []))
    expect(
      reaches.some(([, own]) => own === 0),
      'a coarser level reached',
    ).toBe(true)
    expect(
      reaches.some(([, , keys]) => keys.length === 0),
      'a reach with no cell',
    ).toBe(true)
    const levels = new Set(reaches.map(([level]) => level))
    expect(levels.has(-30) && levels.has(512), 'the finest and the coarsest level').toBe(true)
    const unplaced = records.flatMap((r) => r.placed.flat()).filter((p) => p === null)
    expect(unplaced.length, 'runs no crossing can use').toBeGreaterThan(5)
    const spent = steps.filter((s) => s.candidates.includes('spent'))
    expect(spent.length, 'the work budget spent').toBe(2)
    const exact = steps.some((s) => s.workAfter === MAX_GRID_WORK_PER_SCENE)
    expect(exact, 'the work budget met exactly and not spent').toBe(true)
    const midReach = spent.some((s) => s.reached.some((r) => r !== null && r.length === 0))
    expect(midReach, 'the work budget spent while reaching').toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    expect(
      records[parted]?.id,
      'the first board the TypeScript no longer answers as recorded',
    ).toBeUndefined()
    expect(records.length).toBe(fresh.length)
  })
})
