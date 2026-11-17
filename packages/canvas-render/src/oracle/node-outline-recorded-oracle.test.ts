import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { NodeOutlineRecord } from '../test-utils/node-outline-oracle/oracle.js'

/**
 * The committed recording of what the TypeScript silhouette hit test and edge
 * anchoring answered before they were deleted (ADR-0054 step 7, S18h), which
 * the Rust port replays exactly (`tests/node_outline_oracle.rs` in
 * `crates/core/canvas-render`). This holds that the recording still reaches
 * both answers of the hit test and every way an anchor lands.
 */
const FILE = new URL('./node-outline.jsonl', import.meta.url)

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as NodeOutlineRecord)

describe('the recorded node-outline oracle', () => {
  it('reaches both answers of the hit test and every way an anchor lands', () => {
    const hits = records.flatMap((r) => (r.kind === 'contains' ? [r.inside] : []))
    expect(hits.length, 'hit-test records').toBeGreaterThan(50)
    expect(hits.join('').includes('1') && hits.join('').includes('0')).toBe(true)
    const entries = records.flatMap((r) => (r.kind === 'entry' ? r.approaches : []))
    const moved = entries.filter((a) => a[4] !== a[2] || a[5] !== a[3])
    expect(moved.length, 'terminals pulled inward').toBeGreaterThan(100)
    expect(entries.length - moved.length, 'terminals left where they were').toBeGreaterThan(100)
  })
})
