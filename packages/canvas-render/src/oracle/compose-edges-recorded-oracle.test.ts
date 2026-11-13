import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type ComposeEdgesRecord,
  composeEdgesRecords,
} from '../test-utils/compose-edges-oracle/oracle.js'

/**
 * The committed recording of what the edge pass (`composeEdgesAndLabels`)
 * answers equals what it answers today, and the Rust port replays it exactly
 * (`tests/compose_edges_oracle.rs` in `crates/core/canvas-render`). Re-record
 * after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node compose-edges-recorded`.
 */
const FILE = new URL('./compose-edges.jsonl', import.meta.url)

const fresh = composeEdgesRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as ComposeEdgesRecord)

const cases = records.flatMap((r) => (r.kind === 'case' ? [r] : []))

describe('the recorded compose-edges oracle', () => {
  it('reaches every outcome the edge pass has', () => {
    expect(records[0]?.kind, 'the meta line first').toBe('meta')
    expect(cases.length, 'cases').toBeGreaterThan(100)
    const scenes = cases.map((c) => c.answer.scene)
    const has = (what: string, test: (scene: string) => boolean) =>
      expect(scenes.some(test), what).toBe(true)
    has('a label', (s) => s.includes('"annotates"'))
    has('a hop', (s) => s.includes('"jumps"'))
    has('a pencilled edge', (s) => s.includes('"sketch"'))
    has('a rounded route', (s) => s.includes('"rounded":true'))
    has('a weighed stroke', (s) => s.includes('"strokeWidth"'))
    has('a free end', (s) => s.includes('free ink'))
    expect(
      cases.some((c) => c.answer.jumps !== null && c.answer.jumps.length > 0),
      'jumps',
    ).toBe(true)
    expect(
      cases.some((c) => c.answer.anchors.some((a) => a.includes('around'))),
      'around',
    ).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    const record = records[parted]
    expect(
      record === undefined
        ? undefined
        : `${parted}: ${record.kind === 'case' ? record.id : 'meta'}`,
      'the first record the TypeScript no longer answers as recorded',
    ).toBeUndefined()
    expect(records.length).toBe(fresh.length)
  })
})
