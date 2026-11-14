import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type PassageHighlightRecord,
  passageHighlightRecords,
} from '../test-utils/passage-highlight-oracle.js'

/**
 * The committed recording of what the passage highlights and the searches they
 * run answer equals what they answer today, and the Rust port replays it
 * exactly (`tests/passage_highlight_oracle.rs` in `crates/core/canvas-render`).
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node passage-highlight-recorded`.
 */
const FILE = new URL('./passage-highlight.jsonl', import.meta.url)

const fresh = passageHighlightRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as PassageHighlightRecord)

const boards = records.flatMap((r) => (r.kind === 'highlights' ? [r] : []))

describe('the recorded passage-highlight oracle', () => {
  it('reaches drawn, undrawn, settled and clamped highlights', () => {
    const shapes = boards.flatMap((r) => r.answer.shapes)
    expect(shapes.filter(([, , look]) => look === 'open').length).toBeGreaterThan(50)
    expect(shapes.filter(([, , look]) => look === 'resolved').length).toBeGreaterThan(20)
    expect(boards.filter((r) => r.answer.shapes.length === 0).length).toBeGreaterThan(1)
    expect(shapes.filter(([id]) => /passage-[1-9]$/.test(id)).length).toBeGreaterThan(10)
    expect(boards.some((r) => r.measure === 'odd')).toBe(true)
    const resolved = records.flatMap((r) => (r.kind === 'resolve' ? [r] : []))
    expect(resolved.filter((r) => r.answer === null).length).toBeGreaterThan(20)
    expect(
      resolved.filter((r) => r.answer !== null && r.answer[0] !== r.start).length,
    ).toBeGreaterThan(50)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    expect(parted, 'the first record the TypeScript no longer answers as recorded').toBe(-1)
    expect(records).toHaveLength(fresh.length)
  })
})
