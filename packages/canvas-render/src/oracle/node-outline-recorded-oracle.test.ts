import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type NodeOutlineRecord,
  nodeOutlineRecords,
} from '../test-utils/node-outline-oracle/oracle.js'

/**
 * The committed recording of what `outlineContains` and `outlineEntryPoint`
 * answer equals what they answer today, and the Rust port replays it exactly
 * (`tests/node_outline_oracle.rs` in `crates/core/canvas-render`). Re-record
 * after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node node-outline-recorded`.
 */
const FILE = new URL('./node-outline.jsonl', import.meta.url)

const fresh = nodeOutlineRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

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

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    const record = records[parted]
    expect(
      record === undefined ? undefined : `${parted}: ${record.kind} ${record.shape}`,
      'the first record the TypeScript no longer answers as recorded',
    ).toBeUndefined()
    expect(records.length).toBe(fresh.length)
  })
})
