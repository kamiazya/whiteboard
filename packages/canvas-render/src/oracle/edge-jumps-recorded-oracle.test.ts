import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type EdgeJumpsRecord, edgeJumpsRecords } from '../test-utils/edge-jumps-oracle/oracle.js'

/**
 * The committed recording of what `computeEdgeJumps`
 * (`layout/edges/edge-jumps.ts`) answers equals what it answers today, and
 * the Rust port replays it exactly (`tests/edge_jumps_oracle.rs` in
 * `crates/core/edge-routing`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node edge-jumps-recorded`.
 */
const FILE = new URL('./edge-jumps.jsonl', import.meta.url)

const fresh = edgeJumpsRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as EdgeJumpsRecord)

const board = (id: string) => records.find((r) => r.id === id)
const hopsOf = (r: EdgeJumpsRecord | undefined, id: string) =>
  r?.jumps.find(([edge]) => edge === id)?.[1].length

describe('the recorded edge-jumps oracle', () => {
  it('reaches every way the jumps answer', () => {
    const total = (r: EdgeJumpsRecord | undefined) =>
      (r?.jumps ?? []).reduce((n, [, points]) => n + points.length, 0)
    expect(total(board('scene-cap')), 'the scene cap met').toBe(4096)
    expect(hopsOf(board('scene-cap'), 'target'), 'hand-overs cut by the scene cap').toBe(11)
    expect(hopsOf(board('scene-cap'), 'handing'), 'a rail under the scene cap').toBe(20)
    expect(hopsOf(board('segment-cap'), 'long'), 'the segment cap met').toBe(64)
    expect(hopsOf(board('segment-cap'), 'hand-rail'), 'hand-overs cut by the segment cap').toBe(64)
    const handed = board('hand-overs')
    expect(hopsOf(handed, 'rail-0'), 'a hand-over too close to a hop').toBe(1)
    expect(hopsOf(handed, 'rail-3'), 'a hand-over kept').toBe(2)
    expect(hopsOf(board('splits'), 'flat'), 'a crossing on the later edge’s split').toBe(1)
    expect(hopsOf(board('work-budget'), 'late-h'), 'nothing past the work budget').toBeUndefined()
    expect(hopsOf(board('work-budget'), 'early-h'), 'hops before the work budget').toBe(1)
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
