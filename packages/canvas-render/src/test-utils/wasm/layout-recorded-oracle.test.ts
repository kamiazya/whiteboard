import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type LayoutRecord, layoutRecords } from './layout-oracle.js'

/**
 * The committed recording of what the TypeScript lays out for each request
 * the core can be handed equals what it answers today. The crate replays it
 * through the export itself (`crates/bindings/wasm/tests/layout_oracle.rs`),
 * so cargo-mutants judges the request decoder, the reference host and the
 * answer's writer by the TypeScript's answers. Re-record after a deliberate
 * layout change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node layout-recorded`.
 */
const FILE = new URL('./oracle/layout-spatial-canvas.jsonl', import.meta.url)

describe('the recorded whole-layout oracle', () => {
  const fresh = layoutRecords()
  if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
    writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
  }
  const records = readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as LayoutRecord)

  it('holds every option the request carries, and both outcomes', () => {
    const requests = records.map((r) => r.request).join('\n')
    for (const field of [
      'geometry',
      'lockedNodeIds',
      'suppressedBodyNodeIds',
      'sideOverrides',
      'tagLibrary',
      'embedPath',
      'references',
      '"dark"',
    ]) {
      expect(requests, field).toContain(field)
    }
    expect(records.filter((r) => r.answer.startsWith('["declined"')).length).toBe(2)
    expect(
      records.filter((r) => r.answer.includes('"kind":"unknown-node-kind"')).length,
    ).toBeGreaterThan(0)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    expect(
      parted === -1 ? undefined : records[parted]?.id,
      'the first record that moved',
    ).toBeUndefined()
    expect(records.length).toBe(fresh.length)
  })
})
