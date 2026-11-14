import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { commentBubbleCandidates } from '../layout/comment-placement.js'
import {
  type CommentPlacementRecord,
  commentPlacementRecords,
} from '../test-utils/comment-placement-oracle.js'
import { f64Hex } from '../test-utils/render-oracle/scene-dump.js'

/**
 * The committed recording of what the comment placement primitives answer
 * equals what they answer today, and the Rust port replays it exactly
 * (`tests/comment_placement_oracle.rs` in `crates/core/canvas-render`).
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node comment-placement-recorded`.
 */
const FILE = new URL('./comment-placement.jsonl', import.meta.url)

const fresh = commentPlacementRecords()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const records = readFileSync(FILE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as CommentPlacementRecord)

describe('the recorded comment-placement oracle', () => {
  it('reaches every quadrant and the ring', () => {
    const fromHex = (h: string) => new Float64Array(new BigUint64Array([BigInt(`0x${h}`)]).buffer)[0] ?? 0
    const picked = new Set(
      records.flatMap((r) => {
        if (r.kind !== 'place') return []
        const [x, y] = r.anchor.map(fromHex)
        const [w, h] = r.size.map(fromHex)
        const all = commentBubbleCandidates({ x: x ?? 0, y: y ?? 0 }, { w: w ?? 0, h: h ?? 0 })
        const at = all.findIndex((c) => JSON.stringify([c.x, c.y, c.w, c.h].map(f64Hex)) === JSON.stringify(r.answer))
        return [Math.min(at, 4)]
      }),
    )
    expect([...picked].sort(), 'each quadrant, and a ring box, picked').toEqual([0, 1, 2, 3, 4])
    const kinds = new Set(records.map((r) => r.kind))
    expect([...kinds].sort()).toEqual(['candidates', 'leader', 'nearest', 'place'])
  })

  it('equals what the TypeScript answers today', () => {
    const parted = records.findIndex((r, i) => JSON.stringify(fresh[i]) !== JSON.stringify(r))
    expect(parted, 'the first record the TypeScript no longer answers as recorded').toBe(-1)
    expect(records.length).toBe(fresh.length)
  })
})
