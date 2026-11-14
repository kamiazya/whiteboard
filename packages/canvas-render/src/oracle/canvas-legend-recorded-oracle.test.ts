import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type CanvasLegendRecord, canvasLegendRecords } from '../test-utils/legend-oracle/oracle.js'

/**
 * The committed recording of the board's legend and the colour readings it
 * is derived from equals what the TypeScript answers today, and the Rust port
 * replays it exactly (`tests/compose_canvas_support/legend.rs` in
 * `crates/core/canvas-render`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node canvas-legend-recorded`.
 */
const FILE = new URL('./canvas-legend.jsonl', import.meta.url)

const fresh = canvasLegendRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as CanvasLegendRecord)

describe('the recorded canvas-legend oracle', () => {
  it('reaches every reading and every kind of key', () => {
    for (const use of ['carried', 'contested', 'unused']) {
      expect(
        records.some((r) => r.boxes.use === use),
        `boxes ${use}`,
      ).toBe(true)
      expect(
        records.some((r) => r.edges.use === use),
        `edges ${use}`,
      ).toBe(true)
    }
    const carriers = new Set(records.flatMap((r) => r.boxes.carriedBy))
    for (const name of ['frame', 'kind', 'stencil', 'health', 'x.status/v0']) {
      expect(carriers.has(name), `colour carried by ${name}`).toBe(true)
    }
    const keys = records.flatMap((r) => r.light?.keys ?? [])
    expect(keys.some((k) => k.of === 'boxes')).toBe(true)
    expect(keys.some((k) => k.of === 'edges')).toBe(true)
    expect(records.some((r) => (r.boxes.carriedBy.length ?? 0) >= 2)).toBe(true)
    expect(records.some((r) => r.light === null)).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    expect(parted, 'the first record the TypeScript no longer answers as recorded').toBe(-1)
    expect(records).toHaveLength(fresh.length)
  })
})
