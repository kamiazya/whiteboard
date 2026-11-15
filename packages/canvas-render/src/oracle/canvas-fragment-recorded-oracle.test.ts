import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type CanvasFragmentRecord,
  canvasFragmentAnswer,
  canvasFragmentInputs,
} from '../test-utils/canvas-fragment-oracle.js'

/**
 * The committed recording of what `selectCanvasFragment` answers equals what
 * it answers today, and the Rust port replays it exactly
 * (`tests/canvas_fragment_oracle.rs` in `crates/core/canvas-render`).
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node canvas-fragment-recorded`.
 */
const FILE = new URL('./canvas-fragment.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  const lines = canvasFragmentInputs().map((input) => JSON.stringify(canvasFragmentAnswer(input)))
  writeFileSync(FILE, `${lines.join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as CanvasFragmentRecord)

describe('the recorded canvas fragment oracle', () => {
  it('reaches ids, labels by case, groups with members, kept edges and lines', () => {
    expect(records.length).toBeGreaterThan(500)
    const found = records.filter((r) => r.selected !== null)
    expect(found.length, 'fragments found').toBeGreaterThan(150)
    expect(records.length - found.length, 'fragments naming nothing').toBeGreaterThan(150)
    const byId = found.filter((r) => r.fragment.trim().startsWith('^'))
    expect(byId.length, 'a ^id fragment').toBeGreaterThan(50)
    expect(found.length - byId.length, 'a label fragment').toBeGreaterThan(50)
    expect(found.filter((r) => (r.selected?.nodes.length ?? 0) > 2).length, 'groups with members')
      .toBeGreaterThan(30)
    expect(found.filter((r) => (r.selected?.edges.length ?? 0) > 0).length, 'edges kept')
      .toBeGreaterThan(30)
    const dropped = found.filter((r) => (r.selected?.edges.length ?? 0) < r.canvas.edges.length)
    expect(dropped.length, 'edges dropped').toBeGreaterThan(30)
    expect(found.filter((r) => (r.selected?.lines?.length ?? 0) > 0).length, 'lines kept')
      .toBeGreaterThan(30)
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex(
      (r) => JSON.stringify(canvasFragmentAnswer(r)) !== JSON.stringify(r),
    )
    expect(
      records[parted]?.id,
      'the first case the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})
