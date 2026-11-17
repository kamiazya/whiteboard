import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CanvasLegendRecord } from '../test-utils/legend-oracle/oracle.js'

/**
 * The committed recording of the board's legend and the colour readings it
 * is derived from, taken from the TypeScript before it was deleted (ADR-0054
 * step 7, S18h) and frozen. The Rust port replays it exactly
 * (`tests/compose_canvas_support/legend.rs` in `crates/core/canvas-render`).
 * This test holds the recording to the inputs it must reach.
 */
const FILE = new URL('./canvas-legend.jsonl', import.meta.url)

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
})
