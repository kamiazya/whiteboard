// `computeFreeRegions` rasterises the scene onto a 20px grid, marks the cells
// any node occupies, and reports the maximal horizontal runs of what is left.
// It is the largest single cluster of survivors in `scene-digest.ts` — 44 of
// them — and the reason is that its three example tests each pin ONE row of
// ONE arrangement, while the code is index arithmetic over two dimensions.
//
// So it gets an oracle that shares none of that arithmetic: the same
// specification, rasterised by testing each cell rect against each box rect
// directly instead of by computing column and row spans. The half-open
// convention is the interesting part, and the two derive it independently — a
// box whose right edge lands exactly on a grid line must not claim the cell
// beyond it, which in the implementation is `ceil(...) - 1` and here is
// `x + w > cellX`.
import { describe, expect, it } from 'vitest'
import { sceneDigest } from './scene-digest.js'
import type { BoundingBox, Scene } from './scene-graph.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const GRID = 20

const scene = (boxes: readonly BoundingBox[]): Scene => ({
  nodes: boxes.map((bbox) => ({ kind: 'thematicBreak' as const, bbox })),
})

/**
 * The same rule, computed cell-by-cell. Deliberately the slow way: the
 * implementation's job is to get here by arithmetic, and an oracle that
 * reproduced the arithmetic would agree with a broken one.
 */
function referenceFreeRegions(boxes: readonly BoundingBox[]): BoundingBox[] {
  if (boxes.length === 0) return []
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  const cols = Math.max(1, Math.ceil((maxX - minX) / GRID))
  const rows = Math.max(1, Math.ceil((maxY - minY) / GRID))

  const free: BoundingBox[] = []
  for (let r = 0; r < rows; r++) {
    let runStart = -1
    for (let c = 0; c <= cols; c++) {
      const cellX = minX + c * GRID
      const cellY = minY + r * GRID
      // Half-open on both axes: a box touching a cell's left or top edge
      // occupies it, one touching its right or bottom edge does not.
      const occupied =
        c < cols &&
        boxes.some(
          (b) => b.x < cellX + GRID && b.x + b.w > cellX && b.y < cellY + GRID && b.y + b.h > cellY,
        )
      const isFree = c < cols && !occupied
      if (isFree && runStart === -1) runStart = c
      else if (!isFree && runStart !== -1) {
        free.push({
          x: minX + runStart * GRID,
          y: cellY,
          w: (c - runStart) * GRID,
          h: GRID,
        })
        runStart = -1
      }
    }
  }
  return free.sort((a, b) =>
    a.y === b.y ? (a.x === b.x ? (a.w === b.w ? a.h - b.h : a.w - b.w) : a.x - b.x) : a.y - b.y,
  )
}

// Coordinates and sizes that land ON grid lines as often as between them, and
// zero-size boxes, because the exclusive-edge rule is the whole subtlety and
// a domain of round numbers never asks about it.
const coord = fc.oneof(
  fc.integer({ min: 0, max: 15 }).map((n) => n * GRID),
  fc.integer({ min: 0, max: 300 }),
)
const extent = fc.oneof(fc.constantFrom(0, GRID, 2 * GRID), fc.integer({ min: 0, max: 80 }))
const boxArb = fc.record({ x: coord, y: coord, w: extent, h: extent })
const boardArb = fc.array(boxArb, { minLength: 1, maxLength: 6 })

describe('free regions, against a cell-by-cell oracle', () => {
  const seen = { anyFree: 0, none: 0, multiRow: 0, zeroSize: 0 }

  fcTest.prop([boardArb], withDefaults({ numRuns: 200 }))(
    'agree exactly on which cells are left over',
    (boxes) => {
      const actual = sceneDigest(scene(boxes)).freeRegions
      const expected = referenceFreeRegions(boxes)

      if (actual.length > 0) seen.anyFree++
      else seen.none++
      if (new Set(actual.map((r) => r.y)).size > 1) seen.multiRow++
      if (boxes.some((b) => b.w === 0 || b.h === 0)) seen.zeroSize++

      expect(actual).toEqual(expected)
    },
  )

  it('reached the arrangements the agreement is about', () => {
    // Without this the property is a coin toss: two implementations that both
    // answer `[]` for every board agree perfectly. Boards with no free cell at
    // all are the common case, so they are counted separately rather than
    // allowed to stand in for coverage.
    expect({
      someBoardHadFreeCells: seen.anyFree >= 20,
      someBoardHadNone: seen.none >= 5,
      someSpannedRows: seen.multiRow >= 10,
      someHadZeroSizeBoxes: seen.zeroSize >= 10,
    }).toEqual({
      someBoardHadFreeCells: true,
      someBoardHadNone: true,
      someSpannedRows: true,
      someHadZeroSizeBoxes: true,
    })
  })

  it('never reports a region any node overlaps', () => {
    // The debt the whole derivation owes, stated directly rather than via the
    // oracle: an agent placing a new node into a reported gap must not land it
    // on top of something.
    const boards = fc.sample(boardArb, { numRuns: 200, seed: 31337 })
    // A box with no extent covers no area and so collides with nothing —
    // stated because the first version of this test omitted it and reported 58
    // "collisions", every one of them a `w: 0` or `h: 0` node. That read as a
    // defect in the derivation and was a defect in the question.
    const covers = (b: BoundingBox) => b.w > 0 && b.h > 0
    const collisions = boards.flatMap((boxes) =>
      sceneDigest(scene(boxes)).freeRegions.flatMap((region) =>
        boxes.filter(
          (b) =>
            covers(b) &&
            b.x < region.x + region.w &&
            b.x + b.w > region.x &&
            b.y < region.y + region.h &&
            b.y + b.h > region.y,
        ),
      ),
    )

    expect(collisions).toEqual([])
  })
})
