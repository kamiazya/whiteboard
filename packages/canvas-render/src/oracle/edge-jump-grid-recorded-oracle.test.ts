import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EdgeJumpGridRecord } from '../test-utils/edge-jump-grid-oracle/oracle.js'

/**
 * The committed recording of what the TypeScript line-jump broad phase
 * answered before it was deleted (ADR-0054 step 7, S18h), which the Rust port
 * replays exactly (`tests/edge_jump_grid_oracle.rs` in
 * `crates/core/edge-routing`). This holds that the recording still reaches
 * every way the grid answers.
 */
const FILE = new URL('./edge-jump-grid.jsonl', import.meta.url)

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
})
