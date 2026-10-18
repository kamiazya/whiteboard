/**
 * `placeWithin` must land nodes exactly where the walk it replaced did: an
 * agent predicts a placement from the last one it saw, so a cheaper walk that
 * picks different spots is a behaviour change, not an optimisation.
 *
 * The oracle below is that earlier walk, kept verbatim apart from a step
 * counter: each step asks for the EARLIEST-taken member crowding the
 * candidate by scanning every member in its buckets. It shares no code with
 * the subject — not even the crowding predicate — so a mistake in either
 * shows as a difference.
 *
 * Which member a step clears decides which bottoms the row's `nextRow` is the
 * minimum of, so the arrangements that matter are rows that step past
 * several overlapping members. The generator is dense for that reason, and a
 * reachability floor fails the test if it stops producing them.
 */
import { describe, expect, it } from 'vitest'
import { fc, withDefaults } from '../test-utils/fast-check.js'
import { placeWithin } from './canvas-edit-placement.js'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const GUTTER = 40
const ROW_BUCKET_PX = 512
const MAX_BUCKETS_PER_RECT = 32

function crowds(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width + GUTTER &&
    b.x < a.x + a.width + GUTTER &&
    a.y < b.y + b.height + GUTTER &&
    b.y < a.y + a.height + GUTTER
  )
}

interface RowCursor {
  readonly y: number
  readonly x: number
  readonly midRow?: { readonly nextRow: number }
}

function bucketSpan(top: number, bottom: number): { first: number; last: number } | undefined {
  const first = Math.floor(top / ROW_BUCKET_PX)
  const last = Math.floor(bottom / ROW_BUCKET_PX)
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return undefined
  return last - first > MAX_BUCKETS_PER_RECT ? undefined : { first, last }
}

class OracleTakenRows {
  private readonly rects: Rect[] = []
  private readonly buckets = new Map<number, number[]>()
  private readonly tall: number[] = []

  add(rect: Rect): void {
    const index = this.rects.length
    this.rects.push(rect)
    const span = bucketSpan(rect.y - GUTTER, rect.y + rect.height + GUTTER)
    if (span === undefined) {
      this.tall.push(index)
      return
    }
    for (let bucket = span.first; bucket <= span.last; bucket++) {
      const row = this.buckets.get(bucket)
      if (row === undefined) this.buckets.set(bucket, [index])
      else row.push(index)
    }
  }

  firstCrowding(candidate: Rect): Rect | undefined {
    let first = Number.POSITIVE_INFINITY
    const consider = (index: number) => {
      if (index < first && crowds(candidate, this.rects[index] as Rect)) first = index
    }
    for (const index of this.tall) consider(index)
    const span = bucketSpan(candidate.y, candidate.y + candidate.height)
    if (span === undefined) {
      for (let index = 0; index < this.rects.length; index++) consider(index)
    } else {
      for (let bucket = span.first; bucket <= span.last; bucket++) {
        for (const index of this.buckets.get(bucket) ?? []) consider(index)
      }
    }
    return this.rects[first]
  }
}

/** Rows in which the oracle stepped past more than one member, across a run. */
let multiStepRows = 0

function oracleWalkRow(
  size: { width: number; height: number },
  taken: OracleTakenRows,
  row: RowCursor,
  right: number,
): { at: Rect; resume: RowCursor } | { nextRow: number | undefined } {
  const { y } = row
  let x = row.x
  let nextRow = row.midRow?.nextRow
  let rowStart = row.midRow === undefined
  let steps = 0
  while (rowStart || x + size.width <= right) {
    rowStart = false
    const candidate = { x, y, ...size }
    const hit = taken.firstCrowding(candidate)
    const lowest = hit ?? candidate
    const below = lowest.y + lowest.height + GUTTER
    nextRow = nextRow === undefined ? below : Math.min(nextRow, below)
    if (hit === undefined) {
      if (steps > 1) multiStepRows += 1
      return {
        at: candidate,
        resume: { y, x: x + size.width + GUTTER, midRow: { nextRow } },
      }
    }
    steps += 1
    x = hit.x + hit.width + GUTTER
  }
  if (steps > 1) multiStepRows += 1
  return { nextRow }
}

function oracleFreeSlotFor(
  box: Rect,
  size: { width: number; height: number },
  taken: OracleTakenRows,
  from: RowCursor,
): { at: Rect; resume: RowCursor } {
  const right = box.x + box.width
  let row = from
  for (;;) {
    const walked = oracleWalkRow(size, taken, row, right)
    if ('at' in walked) return walked
    row = {
      y: walked.nextRow ?? row.y + size.height + GUTTER,
      x: box.x + GUTTER,
    }
  }
}

function oraclePlaceWithin(
  box: Rect,
  sizes: readonly { width: number; height: number }[],
  occupied: readonly Rect[],
): { x: number; y: number }[] {
  const taken = new OracleTakenRows()
  for (const rect of occupied) taken.add(rect)
  const out: { x: number; y: number }[] = []
  let from: RowCursor = { y: box.y + GUTTER, x: box.x + GUTTER }
  for (const size of sizes) {
    const slot = oracleFreeSlotFor(box, size, taken, from)
    out.push({ x: slot.at.x, y: slot.at.y })
    taken.add(slot.at)
    from = slot.resume
  }
  return out
}

/** Mostly short, sometimes tall enough to span buckets or to go to the tall list. */
const extent = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 120 }) },
  { weight: 2, arbitrary: fc.integer({ min: 120, max: 1200 }) },
  { weight: 1, arbitrary: fc.integer({ min: 16_000, max: 40_000 }) },
)

const origin = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -300, max: 300 }) },
  { weight: 1, arbitrary: fc.integer({ min: 900_000, max: 1_100_000 }) },
)

const board = origin.chain((y0) =>
  fc.record({
    box: fc.record({
      x: fc.integer({ min: -300, max: 300 }),
      y: fc.constant(y0),
      width: fc.integer({ min: 1, max: 1500 }),
      height: fc.integer({ min: 1, max: 900 }),
    }),
    sizes: fc.array(fc.record({ width: extent, height: extent }), { minLength: 1, maxLength: 8 }),
    occupied: fc.array(
      fc.record({
        x: fc.integer({ min: -200, max: 900 }),
        y: fc.integer({ min: y0 - 100, max: y0 + 400 }),
        width: extent,
        height: extent,
      }),
      { minLength: 4, maxLength: 40 },
    ),
  }),
)

describe('placeWithin against the walk it replaced', () => {
  it('lands every node where the per-step earliest-member walk did', () => {
    multiStepRows = 0
    let boards = 0
    fc.assert(
      fc.property(board, ({ box, sizes, occupied }) => {
        boards += 1
        expect(placeWithin(box, sizes, occupied)).toEqual(oraclePlaceWithin(box, sizes, occupied))
      }),
      withDefaults({ numRuns: 400 }),
    )
    // Reachability: measured at 285-370 multi-step rows per 400 boards.
    expect(boards).toBe(400)
    expect(multiStepRows).toBeGreaterThan(150)
  })
})
