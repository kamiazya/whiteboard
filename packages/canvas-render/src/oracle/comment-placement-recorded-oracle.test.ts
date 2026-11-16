import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMMENT_BUBBLE_OFFSET_PX } from '../comment-geometry.js'
import type { CommentPlacementRecord } from '../test-utils/comment-placement-oracle.js'
import { f64Hex } from '../test-utils/render-oracle/scene-dump.js'

/**
 * The committed recording of what the comment placement primitives answered,
 * taken from the TypeScript before it was deleted (ADR-0054 step 7, S18h) and
 * frozen. The Rust port replays it exactly
 * (`tests/comment_placement_oracle.rs` in `crates/core/canvas-render`), and
 * the editor's compose bubble asks the core's query through the recordings in
 * `query-switch.rust.test.ts`; this test holds the recording to the cases it
 * must reach.
 */
const FILE = new URL('./comment-placement.jsonl', import.meta.url)

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as CommentPlacementRecord)

/** The four boxes hung off the anchor's corners, in the order placement tries them; anything else is a ring box. */
function quadrants(anchor: { x: number; y: number }, size: { w: number; h: number }) {
  const d = COMMENT_BUBBLE_OFFSET_PX
  const [right, left] = [anchor.x + d, anchor.x - d - size.w]
  const [below, above] = [anchor.y + d, anchor.y - d - size.h]
  return [
    { x: right, y: below, ...size },
    { x: right, y: above, ...size },
    { x: left, y: below, ...size },
    { x: left, y: above, ...size },
  ]
}

describe('the recorded comment-placement oracle', () => {
  it('reaches every quadrant and the ring', () => {
    const fromHex = (h: string) =>
      new Float64Array(new BigUint64Array([BigInt(`0x${h}`)]).buffer)[0] ?? 0
    const picked = new Set(
      records.flatMap((r) => {
        if (r.kind !== 'place') return []
        const [x, y] = r.anchor.map(fromHex)
        const [w, h] = r.size.map(fromHex)
        const at = quadrants({ x: x ?? 0, y: y ?? 0 }, { w: w ?? 0, h: h ?? 0 }).findIndex(
          (c) => JSON.stringify([c.x, c.y, c.w, c.h].map(f64Hex)) === JSON.stringify(r.answer),
        )
        return [at === -1 ? 4 : at]
      }),
    )
    expect([...picked].sort(), 'each quadrant, and a ring box, picked').toEqual([0, 1, 2, 3, 4])
    const kinds = new Set(records.map((r) => r.kind))
    expect([...kinds].sort()).toEqual(['candidates', 'leader', 'nearest', 'place'])
  })
})
