// The sweep's differential property cannot see inside the narrow phase,
// because its oracle CALLS the narrow phase. That is deliberate — the sweep's
// claim is exact equality with the full pairwise scan over the SAME scorer,
// and sharing it is what makes the claim by-construction — but it means every
// arithmetic and comparison inside `scoreQuantizedSegmentPair` is mutated on
// both sides at once and the property stays green. Mutation testing measured
// it: 22 survivors, all of them in this one function, against a file that
// otherwise scores well.
//
// So the scorer gets an oracle that does NOT share its code: the same
// specification solved with different machinery — exact BigInt rationals
// instead of sign-normalized cross-multiplication, an absolute-sum axis
// length instead of a two-branch one. What that catches is an implementation
// slip. What it cannot catch is the specification being wrong, which is the
// examples' job, so both are here.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { scoreQuantizedSegmentPair } from './edge-crossing-sweep.js'
import { EDGE_JUMP_RADIUS_PX } from './edge-jumps.js'

/**
 * Restated from the definition rather than imported, on purpose: an oracle
 * that reads its constants from the module under test cannot see a mutation
 * of them. `COST_QUANTUM` is quarter-pixel integers, and the clearance is one
 * pixel outside the jump radius.
 */
const QUANTUM = 4
const CLEARANCE = (EDGE_JUMP_RADIUS_PX + 1) * QUANTUM

/** Exact for an axis-aligned segment, rounded hypot otherwise. */
function referenceAxisLength(dx: number, dy: number): number {
  // `|dx| + |dy|` IS the length when one of them is zero, so the two
  // axis-aligned cases need no branch of their own here.
  return dx === 0 || dy === 0 ? Math.abs(dx) + Math.abs(dy) : Math.round(Math.hypot(dx, dy))
}

function referenceScore(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): readonly [number, number, number] {
  // 1. Two segments on the same axis-parallel LINE contribute the length
  //    their projections share, and never a crossing.
  const onOneHorizontal = ay1 === ay2 && by1 === by2 && ay1 === by1
  const onOneVertical = ax1 === ax2 && bx1 === bx2 && ax1 === bx1
  if (onOneHorizontal || onOneVertical) {
    const [p, q, r, s] = onOneHorizontal ? [ax1, ax2, bx1, bx2] : [ay1, ay2, by1, by2]
    const lo = Math.max(Math.min(p, q), Math.min(r, s))
    const hi = Math.min(Math.max(p, q), Math.max(r, s))
    return [Math.max(hi - lo, 0), 0, 0]
  }

  // 2. Solve a1 + t(a2-a1) = b1 + u(b2-b1) over the rationals, exactly, and
  //    require both parameters STRICTLY inside (0, 1) — an intersection at an
  //    endpoint is a join, not a crossing.
  const dax = BigInt(ax2 - ax1)
  const day = BigInt(ay2 - ay1)
  const dbx = BigInt(bx2 - bx1)
  const dby = BigInt(by2 - by1)
  const denom = dax * dby - day * dbx
  if (denom === 0n) return [0, 0, 0]
  const tn = BigInt(bx1 - ax1) * dby - BigInt(by1 - ay1) * dbx
  const un = BigInt(bx1 - ax1) * day - BigInt(by1 - ay1) * dax
  const strictlyInside = (n: bigint): boolean =>
    denom > 0n ? n > 0n && n < denom : n < 0n && n > denom
  if (!strictlyInside(tn) || !strictlyInside(un)) return [0, 0, 0]

  // 3. The crossing is illegible when it falls within the clearance of any of
  //    the four segment ends, measured ALONG that segment: t*|A| < clearance,
  //    compared without dividing.
  const span = denom > 0n ? denom : -denom
  const alongA = denom > 0n ? tn : -tn
  const alongB = denom > 0n ? un : -un
  const lenA = BigInt(referenceAxisLength(ax2 - ax1, ay2 - ay1))
  const lenB = BigInt(referenceAxisLength(bx2 - bx1, by2 - by1))
  const budget = BigInt(CLEARANCE) * span
  const tooClose = [
    alongA * lenA,
    (span - alongA) * lenA,
    alongB * lenB,
    (span - alongB) * lenB,
  ].some((distance) => distance < budget)
  return [0, tooClose ? 1 : 0, 1]
}

const score = scoreQuantizedSegmentPair

describe('the narrow phase, on its documented clauses', () => {
  it('scores two collinear horizontal segments by the length they share', () => {
    expect(score(0, 0, 100, 0, 40, 0, 300, 0)).toEqual([60, 0, 0])
  })

  it('scores two collinear vertical segments the same way', () => {
    expect(score(0, 0, 0, 100, 0, 40, 0, 300)).toEqual([60, 0, 0])
  })

  it('scores collinear segments that merely touch as nothing', () => {
    // `hi > lo`, not `hi >= lo`: a shared endpoint is where a lane joins, and
    // charging it as overlap would price every fan-out anchor.
    expect(score(0, 0, 100, 0, 100, 0, 300, 0)).toEqual([0, 0, 0])
  })

  it('scores parallel segments on DIFFERENT lines as nothing', () => {
    expect(score(0, 0, 100, 0, 0, 40, 100, 40)).toEqual([0, 0, 0])
  })

  it('counts a clean transversal crossing once, legibly', () => {
    // The crossing sits 200 quantized units from every end, well past the
    // 24-unit clearance.
    expect(score(-200, 0, 200, 0, 0, -200, 0, 200)).toEqual([0, 0, 1])
  })

  it('calls a crossing close to an end illegible', () => {
    // Crossing at x = 180 on a segment ending at 200: 20 units of run-out,
    // inside the 24-unit clearance.
    expect(score(-200, 0, 200, 0, 180, -200, 180, 200)).toEqual([0, 1, 1])
  })

  // The clearance is FOUR comparisons — each end of each segment — and a
  // property only reaches whichever the draw happens to produce. Each row
  // isolates one: the crossing sits at that end's boundary and comfortably
  // clear of the other three, so the row fails if that one comparison moves,
  // in either direction. `24` is the clearance in quantized units; `23` is
  // one unit inside it.
  it.each([
    ["A's near end", [0, 0, 200, 0, 24, -100, 24, 100], [0, 0, 200, 0, 23, -100, 23, 100]],
    ["A's far end", [0, 0, 200, 0, 176, -100, 176, 100], [0, 0, 200, 0, 177, -100, 177, 100]],
    ["B's near end", [0, 0, 200, 0, 100, -24, 100, 200], [0, 0, 200, 0, 100, -23, 100, 200]],
    ["B's far end", [0, 0, 200, 0, 100, -200, 100, 24], [0, 0, 200, 0, 100, -200, 100, 23]],
  ])('reads the clearance at %s as an exclusive bound', (_end, at, inside) => {
    const call = (a: readonly number[]) =>
      score(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!, a[6]!, a[7]!)

    expect(call(at)).toEqual([0, 0, 1])
    expect(call(inside)).toEqual([0, 1, 1])
  })

  // The open interval is also four comparisons, one per endpoint that can
  // land on the other segment. A join is not a crossing, and counting one
  // would price every anchor where a lane meets a node.
  it.each([
    ['A begins on B', [0, 0, 200, 0, 0, -200, 0, 200]],
    ['A ends on B', [-200, 0, 0, 0, 0, -200, 0, 200]],
    ['B begins on A', [-200, 0, 200, 0, 0, 0, 0, 200]],
    ['B ends on A', [-200, 0, 200, 0, 0, -200, 0, 0]],
  ])('does not count a junction where %s', (_where, args) => {
    expect(
      score(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!, args[6]!, args[7]!),
    ).toEqual([0, 0, 0])
  })

  it('counts a segment that merely BEGINS on a lane as no overlap', () => {
    // All three equalities are load-bearing, and the middle one is the least
    // obvious: B starts ON A's line and leaves it, so B is not collinear with
    // anything. Reading only "A is horizontal and B starts at A's y" charges
    // the whole x-span they share as lane overlap — 200 units for two
    // segments that touch at one point.
    expect(score(-200, 0, 200, 0, -100, 0, 100, 200)).toEqual([0, 0, 0])
  })

  it('measures clearance along a DIAGONAL by its true length, not its run', () => {
    // A is the 3-4-5 diagonal (0,0)-(300,400), so its length is 500 while its
    // x-run is 300. The crossing sits at (18, 24): 30 units along A, clear of
    // the 24-unit clearance — but only 18 units of x-run, which is inside it.
    // Charging the run instead calls a legible crossing illegible, and every
    // diagonal in the board pays for it.
    expect(score(0, 0, 300, 400, -100, 24, 200, 24)).toEqual([0, 0, 1])
  })

  it('does not count segments that would cross only if extended', () => {
    expect(score(-200, 0, -100, 0, 0, -200, 0, 200)).toEqual([0, 0, 0])
  })
})

describe('the narrow phase against a reference solved differently', () => {
  // Coarse values dominate so that shared coordinates — the collinear and
  // parallel clauses — actually occur; a purely fine grid reaches them almost
  // never. The span is wide enough that a crossing can clear 24 units at both
  // ends, so legible and illegible crossings both appear.
  const coarse = fc.integer({ min: -4, max: 4 }).map((n) => n * 60)
  const fine = fc.integer({ min: -240, max: 240 })
  const coord = fc.oneof({ weight: 2, arbitrary: coarse }, { weight: 1, arbitrary: fine })

  const segment = fc.oneof(
    // Horizontal, vertical and free segments in equal measure: real routes are
    // axis-aligned-dominant, and the axis-aligned pairs are the ones that
    // reach the collinear clause at all.
    fc.tuple(coord, coord, coord).map(([x1, x2, y]) => [x1, y, x2, y] as const),
    fc.tuple(coord, coord, coord).map(([y1, y2, x]) => [x, y1, x, y2] as const),
    fc.tuple(coord, coord, coord, coord).map(([x1, y1, x2, y2]) => [x1, y1, x2, y2] as const),
  )

  /**
   * Two segments placed on ONE axis-parallel line. Drawing them independently
   * does not reach this: two horizontals landing on the same y is ~1 draw in
   * 200 even with a coarse grid, which the ledger below measured as zero
   * collinear overlaps in a full run. The clause is a third of the function,
   * so the pair generator is composed of the arrangement families instead of
   * hoping for them.
   */
  const line = fc.constantFrom(-120, 0, 120)
  const collinearPair = fc
    .tuple(fc.boolean(), line, coord, coord, coord, coord)
    .map(([horizontal, at, p, q, r, s]) =>
      horizontal
        ? ([
            [p, at, q, at],
            [r, at, s, at],
          ] as const)
        : ([
            [at, p, at, q],
            [at, r, at, s],
          ] as const),
    )

  /**
   * A crossing placed a controlled distance from one end. The clearance test
   * is a third of this function, and a uniformly-drawn crossing lands within
   * the 24-unit clearance of an endpoint only rarely: measured, `illegible`
   * hovered at the ledger's floor and failed it outright on some seeds, which
   * is a flaky test standing in for a domain that does not reach its subject.
   */
  const clearanceCrossing = fc
    .tuple(coarse, coarse, fc.integer({ min: 1, max: 48 }), fc.integer({ min: 1, max: 200 }))
    .map(
      ([ox, oy, offset, reach]) =>
        [
          [ox, oy, ox + 200, oy],
          [ox + offset, oy - reach, ox + offset, oy + reach],
        ] as const,
    )

  const pair = fc.oneof(
    { weight: 2, arbitrary: collinearPair },
    { weight: 2, arbitrary: clearanceCrossing },
    { weight: 3, arbitrary: fc.tuple(segment, segment) },
  )

  const ARRANGEMENTS = {
    'collinear overlap': 'two segments sharing a stretch of one axis-parallel line',
    'collinear or parallel, no overlap': 'the same clause returning zero',
    'crossing, legible': 'a transversal crossing clear of every endpoint',
    'crossing, illegible': 'a transversal crossing inside the end clearance',
    'no interaction': 'neither collinear nor crossing',
  } as const
  const seen = new Map<string, number>()
  const FLOOR = 5
  const note = (key: keyof typeof ARRANGEMENTS): void => {
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }

  fcTest.prop([pair], withDefaults())(
    'agrees with it on every arrangement the domain produces',
    ([a, b]) => {
      const args = [...a, ...b] as [number, number, number, number, number, number, number, number]
      const actual = score(...args)
      expect(actual).toEqual(referenceScore(...args))

      const [overlap, illegible, crossings] = actual
      if (overlap > 0) note('collinear overlap')
      else if (crossings === 0) {
        const [ax1, ay1, ax2, ay2, bx1, by1, bx2, by2] = args
        const sameLine =
          (ay1 === ay2 && by1 === by2 && ay1 === by1) || (ax1 === ax2 && bx1 === bx2 && ax1 === bx1)
        note(sameLine ? 'collinear or parallel, no overlap' : 'no interaction')
      } else note(illegible === 1 ? 'crossing, illegible' : 'crossing, legible')
    },
  )

  it('reaches every arrangement the agreement is supposed to cover', () => {
    // Without this the property is a coin toss: a domain that never produces
    // a crossing agrees with any reference at all, and reports 200 passes.
    // Both of the generator families above exist because this ledger failed
    // without them — collinear overlap at zero, then illegible crossings at
    // one or two. Measured over three 200-run passes the scarcest arrangement
    // landed 17 times and the commonest 74, so the floor sits well under the
    // range without pinning a distribution.
    const reached = Object.fromEntries(
      Object.keys(ARRANGEMENTS).map((key) => [key, (seen.get(key) ?? 0) >= FLOOR]),
    )
    expect(reached).toEqual(Object.fromEntries(Object.keys(ARRANGEMENTS).map((key) => [key, true])))
  })
})
