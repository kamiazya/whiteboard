import { describe, expect, it } from 'vitest'
import { scoreSegmentPair } from './edge-crossing-sweep.js'
import {
  addCost,
  COST_QUANTUM,
  dominantAxisOrder,
  hasRepairableProblem,
  lessCost,
  PENALTY_RULES,
  type PenaltyRule,
  type PreferenceRule,
  pairPenalty,
  type Rect,
  SIDE_PREFERENCE_RULES,
  selfPenalty,
  shouldAdoptCandidate,
  ZERO_LANE_MIN_OVERLAP_PX,
  zeroPenalty,
} from './edge-rules.js'

/** A zero cost tuple with one rule's slot set, built from the DECLARED tier so
 * a deliberate reorder never rewrites an expectation. */
const costAt = (name: string, value: number): number[] => {
  const cost = zeroPenalty()
  cost[tierOf(name)] = value
  return cost
}

/** The declared slot for a rule, so a deliberate tier reorder never edits a test. */
const tierOf = (name: string): number => {
  const rule = PENALTY_RULES.find((r) => r.name === name)
  if (rule === undefined) throw new Error(`no penalty rule named ${name}`)
  return rule.tier
}

function candidateRule(name: string): Extract<PreferenceRule, { kind: 'candidates' }> {
  const rule = SIDE_PREFERENCE_RULES.find((r) => r.name === name)
  if (rule === undefined || rule.kind !== 'candidates') {
    throw new Error(`no candidate rule named ${name}`)
  }
  return rule
}

const rectAt = (x: number, y: number, w = 100, h = 100): Rect => ({ x, y, w, h })

describe('zero-bend-facing-first', () => {
  const rule = candidateRule('zero-bend-facing-first')

  it('ranks the opposing pair when the facing lane clears the minimum overlap and the gap is valid', () => {
    // fromRect span_h = [10, 90]; toRect (y=60) span_h = [70, 150] -> overlap
    // exactly ZERO_LANE_MIN_OVERLAP_PX (20px), the qualifying boundary.
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 60)
    expect(rule.generate({ dx: 200, dy: 60, fromRect, toRect, crowd: () => 0 })).toEqual([
      { fromSide: 'right', toSide: 'left' },
    ])
  })

  it('excludes the pair when the shared lane is 1px short of the minimum overlap', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 61) // overlap 19px, one under ZERO_LANE_MIN_OVERLAP_PX
    expect(rule.generate({ dx: 200, dy: 61, fromRect, toRect, crowd: () => 0 })).toEqual([])
    expect(ZERO_LANE_MIN_OVERLAP_PX).toBe(20)
  })

  // The facing-gap test is FOUR comparisons — one per direction — and each is
  // an inclusive bound, so boxes that touch edge to edge still face each
  // other. Nothing reached that boundary, nor two of the four directions at
  // all: measured, `facingGapOk` carried 26 surviving mutants, more than any
  // other function in the file. Each row is the boundary and the first case
  // past it, so a comparison that moves is caught whichever way it moves.
  it.each([
    ['right', rectAt(0, 0), rectAt(100, 0), rectAt(99, 0), { fromSide: 'right', toSide: 'left' }],
    ['left', rectAt(100, 0), rectAt(0, 0), rectAt(1, 0), { fromSide: 'left', toSide: 'right' }],
    ['bottom', rectAt(0, 0), rectAt(0, 100), rectAt(0, 99), { fromSide: 'bottom', toSide: 'top' }],
    ['top', rectAt(0, 100), rectAt(0, 0), rectAt(0, 1), { fromSide: 'top', toSide: 'bottom' }],
  ])('counts boxes touching edge to edge as facing, leaving %s', (_direction, fromRect, touching, overlapping, pair) => {
    const ctxFor = (toRect: Rect) => ({
      dx: toRect.x + toRect.w / 2 - (fromRect.x + fromRect.w / 2),
      dy: toRect.y + toRect.h / 2 - (fromRect.y + fromRect.h / 2),
      fromRect,
      toRect,
      crowd: () => 0,
    })

    expect(rule.generate(ctxFor(touching))).toEqual([pair])
    // One pixel of interpenetration and the same pair is gone: the straight
    // segment would run backwards through the overlap.
    expect(rule.generate(ctxFor(overlapping))).toEqual([])
  })

  it('excludes an interpenetrating pair even with ample span overlap', () => {
    // to's leading edge sits inside from's body on BOTH axes: no genuine facing gap.
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(50, 0)
    expect(rule.generate({ dx: 50, dy: 0, fromRect, toRect, crowd: () => 0 })).toEqual([])
  })
})

describe('dominant-axis-first', () => {
  it('orders the horizontal variant first when |dx| > |dy|', () => {
    expect(dominantAxisOrder(10, 1, 'H', 'V')).toEqual(['H', 'V'])
  })

  it('orders the vertical variant first when |dy| > |dx|', () => {
    expect(dominantAxisOrder(1, 10, 'H', 'V')).toEqual(['V', 'H'])
  })

  it('keeps the horizontal-first tie-break when |dx| === |dy|', () => {
    expect(dominantAxisOrder(5, 5, 'H', 'V')).toEqual(['H', 'V'])
    expect(dominantAxisOrder(-5, 5, 'H', 'V')).toEqual(['H', 'V'])
    expect(dominantAxisOrder(0, 0, 'H', 'V')).toEqual(['H', 'V'])
  })
})

describe('l-pair-crowding-tie-break', () => {
  const rule = candidateRule('l-pair-crowding-tie-break')

  it('returns no candidates for a purely axis-aligned offset (no diagonal L exists)', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 0)
    expect(rule.generate({ dx: 100, dy: 0, fromRect, toRect, crowd: () => 0 })).toEqual([])
  })

  it('keeps the dominant-axis order when crowding ties (stable sort)', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 150)
    expect(rule.generate({ dx: 100, dy: 50, fromRect, toRect, crowd: () => 0 })).toEqual([
      { fromSide: 'right', toSide: 'top' },
      { fromSide: 'bottom', toSide: 'left' },
    ])
  })

  it('prefers the less-crowded L-pair over the dominant-axis default', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 150)
    const crowd = (end: 'from' | 'to', side: string) =>
      end === 'from' && side === 'right' ? 10 : 0
    expect(rule.generate({ dx: 100, dy: 50, fromRect, toRect, crowd })).toEqual([
      { fromSide: 'bottom', toSide: 'left' },
      { fromSide: 'right', toSide: 'top' },
    ])
  })
})

describe('u-hook-when-degenerate', () => {
  const rule = candidateRule('u-hook-when-degenerate')

  it('offers same-side U-hook pairs when no zero-bend, L, or gap-valid opposing pair exists', () => {
    // Same-axis interpenetrating boxes: dy=0 keeps the L-pair rule empty,
    // and the x-overlap invalidates both opposing gaps.
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(50, 0)
    expect(rule.generate({ dx: 50, dy: 0, fromRect, toRect, crowd: () => 0 })).toEqual([
      { fromSide: 'top', toSide: 'top' },
      { fromSide: 'bottom', toSide: 'bottom' },
    ])
  })

  it('yields nothing once a valid zero-bend alternative exists', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 60)
    expect(rule.generate({ dx: 200, dy: 60, fromRect, toRect, crowd: () => 0 })).toEqual([])
  })
})

describe('gap-valid-opposing-before-invalid', () => {
  const rule = candidateRule('gap-valid-opposing-before-invalid')

  it('moves the gap-valid opposing pair ahead of the gap-invalid one, even off the dominant axis', () => {
    // h is dominant (dx=10 > dy=5) but the h-gap is invalid (x-overlap);
    // the v-gap is valid, so opposingV must lead despite not being dominant.
    const fromRect = rectAt(0, 0, 100, 50)
    const toRect = rectAt(50, 100, 100, 50)
    expect(rule.generate({ dx: 10, dy: 5, fromRect, toRect, crowd: () => 0 })).toEqual([
      { fromSide: 'bottom', toSide: 'top' },
      { fromSide: 'right', toSide: 'left' },
    ])
  })

  it('keeps the dominant-axis order when both gaps are valid', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 200)
    expect(rule.generate({ dx: 150, dy: 100, fromRect, toRect, crowd: () => 0 })).toEqual([
      { fromSide: 'right', toSide: 'left' },
      { fromSide: 'bottom', toSide: 'top' },
    ])
  })

  it('always contains both opposing pairs, regardless of gap validity', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(50, 0)
    const pairs = rule.generate({ dx: 50, dy: 0, fromRect, toRect, crowd: () => 0 })
    expect(pairs).toHaveLength(2)
    expect(pairs).toEqual(
      expect.arrayContaining([
        { fromSide: 'right', toSide: 'left' },
        { fromSide: 'bottom', toSide: 'top' },
      ]),
    )
  })
})

describe('incumbent-wins-ties', () => {
  const lessCost = (a: readonly number[], b: readonly number[]) => (a[0] ?? 0) < (b[0] ?? 0)

  it('rejects an equal-cost candidate', () => {
    expect(shouldAdoptCandidate([5], [5], lessCost)).toBe(false)
  })

  it('accepts a strictly lower-cost candidate', () => {
    expect(shouldAdoptCandidate([4], [5], lessCost)).toBe(true)
  })

  it('rejects a higher-cost candidate', () => {
    expect(shouldAdoptCandidate([6], [5], lessCost)).toBe(false)
  })
})

describe('SIDE_PREFERENCE_RULES', () => {
  it('declares exactly the seven named rules from decision #10, in order', () => {
    expect(SIDE_PREFERENCE_RULES.map((r) => r.name)).toEqual([
      'zero-bend-facing-first',
      'dominant-axis-first',
      'l-pair-crowding-tie-break',
      'u-hook-when-degenerate',
      'gap-valid-opposing-before-invalid',
      'u-hook-span-exposed-first',
      'incumbent-wins-ties',
    ])
  })
})

describe('u-hook-span-exposed-first', () => {
  const rule = candidateRule('u-hook-span-exposed-first')

  it('is total: always offers all four same-side hooks, only reordered', () => {
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(200, 200)
    const pairs = rule.generate({ dx: 200, dy: 200, fromRect, toRect, crowd: () => 0 })
    expect(pairs).toHaveLength(4)
    expect(new Set(pairs.map((p) => p.fromSide))).toEqual(
      new Set(['top', 'right', 'bottom', 'left']),
    )
  })

  it('demotes a departure side whose border runs through the target body, on the reported canvas', () => {
    // A(100,570,200,100) -> B(220,520,200,100): A's top border (y=570,
    // x[100,300]) runs strictly through B's interior for x in (220,300);
    // A's bottom border (y=670) misses B's y-range [520,620] entirely.
    const fromRect: Rect = { x: 100, y: 570, w: 200, h: 100 }
    const toRect: Rect = { x: 220, y: 520, w: 200, h: 100 }
    const pairs = rule.generate({ dx: 120, dy: -50, fromRect, toRect, crowd: () => 0 })
    const bottomIndex = pairs.findIndex((p) => p.fromSide === 'bottom')
    const topIndex = pairs.findIndex((p) => p.fromSide === 'top')
    expect(bottomIndex).toBeLessThan(topIndex)
  })

  it('never demotes any side when the other endpoint fully contains this one (group-frame exclusion)', () => {
    const fromRect: Rect = { x: 10, y: 10, w: 20, h: 20 }
    const toRect: Rect = { x: 0, y: 0, w: 200, h: 200 }
    const pairs = rule.generate({ dx: 0, dy: 0, fromRect, toRect, crowd: () => 0 })
    expect(pairs).toEqual([
      { fromSide: 'top', toSide: 'top' },
      { fromSide: 'right', toSide: 'right' },
      { fromSide: 'bottom', toSide: 'bottom' },
      { fromSide: 'left', toSide: 'left' },
    ])
  })

  it('keeps compass order stable among sides that share the same taint status', () => {
    // Neither endpoint's border runs through the other: nothing is
    // demoted, so the fixed compass order survives unchanged.
    const fromRect = rectAt(0, 0)
    const toRect = rectAt(400, 400)
    expect(rule.generate({ dx: 400, dy: 400, fromRect, toRect, crowd: () => 0 })).toEqual([
      { fromSide: 'top', toSide: 'top' },
      { fromSide: 'right', toSide: 'right' },
      { fromSide: 'bottom', toSide: 'bottom' },
      { fromSide: 'left', toSide: 'left' },
    ])
  })
})

describe('PENALTY_RULES', () => {
  it('declares the seven named tiers in tier order, realized-bends last', () => {
    expect(PENALTY_RULES.map((r) => r.name)).toEqual([
      'overlap-and-intrusion',
      'illegibility',
      'crossings',
      'endpoint-body-ink',
      'border-tracing',
      'path-reversal',
      'realized-bends',
    ])
    PENALTY_RULES.forEach((rule, i) => {
      expect(rule.tier).toBe(i)
    })
    expect(PENALTY_RULES[PENALTY_RULES.length - 1]?.name).toBe('realized-bends')
  })
})

describe('overlap-and-intrusion', () => {
  it('pair term: collinear horizontal segments with 10px x-overlap contribute 10*COST_QUANTUM to tier 0', () => {
    const triple = scoreSegmentPair(
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 10, y: 0 },
      { x: 30, y: 0 },
    )
    expect(pairPenalty(triple)).toEqual([10 * COST_QUANTUM, 0, 0, 0, 0, 0, 0])
  })

  it('self term: a path retracing its own ink contributes the quantized retrace length to tier 0', () => {
    // Out to (20,0), back to (5,0): the [20,0]-[5,0] segment retraces
    // [0,0]-[20,0] over x in [5,20], a 15px overlap. The doubling-back on x
    // also reverses once (tier 5), and the direction change is one bend
    // (tier 6).
    const path = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 5, y: 0 },
    ]
    expect(selfPenalty(path, [])).toEqual([15 * COST_QUANTUM, 0, 0, 0, 0, 1, 1])
  })

  it('self term: a segment through a foreign rect interior contributes the quantized chord length to tier 0', () => {
    const path = [
      { x: -10, y: 50 },
      { x: 110, y: 50 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual([100 * COST_QUANTUM, 0, 0, 0, 0, 0, 0])
  })

  it('self term: a segment riding exactly on the rect boundary contributes 0 (grazing exclusion)', () => {
    const path = [
      { x: -10, y: 0 },
      { x: 110, y: 0 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual(zeroPenalty())
  })

  // The four cases below pin the branches the term takes BEFORE it measures
  // anything: which axis a segment runs along, and whether it runs along one
  // at all. The scoreboard prices them in aggregate, which says a rewrite
  // changed nothing overall but not which case a future one breaks.
  it('self term: a VERTICAL segment through a foreign rect interior is scored like the horizontal one', () => {
    const path = [
      { x: 50, y: -10 },
      { x: 50, y: 110 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual(costAt('overlap-and-intrusion', 100 * COST_QUANTUM))
  })

  it('self term: a vertical segment on the rect LEFT border grazes, exactly as a horizontal one does on the top', () => {
    const path = [
      { x: 0, y: -10 },
      { x: 0, y: 110 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual(zeroPenalty())
  })

  it('self term: a diagonal segment tunnels through nothing — only an axis-aligned one can', () => {
    // The start x sits STRICTLY inside the rect on purpose. A diagonal
    // starting outside it scores zero either way — the vertical branch would
    // reject it on the same coordinate test — so such a case cannot tell
    // whether the skip is there at all (mutation-checked: it is not). This
    // one would be charged 90px of intrusion without it.
    const path = [
      { x: 10, y: -10 },
      { x: 110, y: 90 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual(zeroPenalty())
  })

  it('self term: a zero-length segment inside a rect contributes nothing', () => {
    // Both axes read as equal, so the segment answers to neither branch —
    // and an intrusion of zero length is what it actually is.
    const path = [
      { x: 50, y: 50 },
      { x: 50, y: 50 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual(zeroPenalty())
  })

  it('self term: a vertical retrace is charged its quantized length, mirroring the horizontal case', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 0, y: 5 },
    ]
    expect(selfPenalty(path, [])).toEqual([15 * COST_QUANTUM, 0, 0, 0, 0, 1, 1])
  })

  it('self term: a retrace shorter than one quantum is not ink, though the turn is still a bend', () => {
    // 0.4 of a quantum out and back: the overlap rounds to nothing, while
    // realized-bends counts the direction change off the raw geometry. The
    // two tiers reading the same path at different resolutions is the point
    // — quantization is the ink terms' own rule, not the path's.
    const path = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0, y: 0 },
    ]
    expect(selfPenalty(path, [])).toEqual(costAt('realized-bends', 1))
  })
})

describe('illegibility', () => {
  it('pair term: a transversal crossing near a segment end contributes 1 to tier 1 (and to tier 2, as a crossing), 0 to tier 0', () => {
    // a: (0,0)-(10,10); b: (1,9)-(9,1) crosses near a's start.
    const triple = scoreSegmentPair(
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 1, y: 9 },
      { x: 9, y: 1 },
    )
    expect(pairPenalty(triple)).toEqual([0, 1, 1, 0, 0, 0, 0])
  })

  it('pair term: a transversal crossing far from every end contributes 0 to tier 1', () => {
    const triple = scoreSegmentPair(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    )
    expect(pairPenalty(triple)).toEqual([0, 0, 1, 0, 0, 0, 0])
  })
})

describe('crossings', () => {
  it('pair term: one clean X-crossing contributes 1 to tier 2', () => {
    const triple = scoreSegmentPair(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    )
    expect(pairPenalty(triple)).toEqual([0, 0, 1, 0, 0, 0, 0])
  })

  it('collinear overlap short-circuits the crossing count for that segment pair', () => {
    const triple = scoreSegmentPair(
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 10, y: 0 },
      { x: 30, y: 0 },
    )
    expect(triple[0]).toBeGreaterThan(0)
    expect(pairPenalty(triple)[2]).toBe(0)
  })
})

describe('border-tracing', () => {
  const rect: Rect = { x: 0, y: 0, w: 100, h: 40 }

  it('self term: a horizontal segment lying along the rect top contributes the quantized clipped overlap length to the border-tracing tier', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(selfPenalty(path, [], [rect])).toEqual(costAt('border-tracing', 100 * COST_QUANTUM))
  })

  it('self term: a vertical segment lying along the rect right side contributes the quantized overlap length to the border-tracing tier', () => {
    const path = [
      { x: 100, y: 0 },
      { x: 100, y: 40 },
    ]
    expect(selfPenalty(path, [], [rect])).toEqual(costAt('border-tracing', 40 * COST_QUANTUM))
  })

  it('self term: a perpendicular segment touching the border at a single point contributes 0', () => {
    const path = [
      { x: 50, y: -20 },
      { x: 50, y: 0 },
    ]
    expect(selfPenalty(path, [], [rect])).toEqual(zeroPenalty())
  })

  it('self term: a segment parallel to a side but offset by 1px contributes 0', () => {
    const path = [
      { x: 0, y: 1 },
      { x: 100, y: 1 },
    ]
    expect(selfPenalty(path, [], [rect])).toEqual(zeroPenalty())
  })

  it('self term: a segment collinear with a side but disjoint along the axis contributes 0', () => {
    const path = [
      { x: 150, y: 0 },
      { x: 200, y: 0 },
    ]
    expect(selfPenalty(path, [], [rect])).toEqual(zeroPenalty())
  })

  it('self term: overlap is clipped to the side length when the segment overhangs both corners', () => {
    const path = [
      { x: -50, y: 0 },
      { x: 200, y: 0 },
    ]
    expect(selfPenalty(path, [], [rect])[tierOf('border-tracing')]).toBe(100 * COST_QUANTUM)
  })

  it('self term: a zero-height rect is charged once, not twice, for a segment lying on it', () => {
    const flat: Rect = { x: 0, y: 0, w: 100, h: 0 }
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(selfPenalty(path, [], [flat])[tierOf('border-tracing')]).toBe(100 * COST_QUANTUM)
  })

  it('self term: fires against the path’s OWN endpoint node, unlike foreignBodies which excludes it', () => {
    // foreignBodies deliberately excludes an edge's own endpoints (tunnel
    // check); nodeBorders deliberately does NOT — the whole point is
    // pricing a segment riding the SOURCE node's own border.
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(selfPenalty(path, [rect], [rect])).toEqual(costAt('border-tracing', 100 * COST_QUANTUM))
  })

  it('defaults nodeBorders to [] when omitted, contributing 0 (no border ink declared)', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(selfPenalty(path, [])).toEqual(zeroPenalty())
  })
})

describe('endpoint-body-ink', () => {
  const rect: Rect = { x: 0, y: 0, w: 100, h: 40 }

  it('self term: a horizontal segment strictly between the rect top and bottom contributes the quantized clipped chord length to the endpoint-body-ink tier', () => {
    const path = [
      { x: -10, y: 20 },
      { x: 110, y: 20 },
    ]
    expect(selfPenalty(path, [], [], [rect])).toEqual(
      costAt('endpoint-body-ink', 100 * COST_QUANTUM),
    )
  })

  it('self term: a vertical segment strictly between the rect left and right contributes the quantized clipped chord length to the endpoint-body-ink tier', () => {
    const path = [
      { x: 50, y: -10 },
      { x: 50, y: 50 },
    ]
    expect(selfPenalty(path, [], [], [rect])).toEqual(
      costAt('endpoint-body-ink', 40 * COST_QUANTUM),
    )
  })

  it('self term: a segment riding exactly on the border contributes 0 to this tier (border-tracing prices it instead, no double-charge)', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    const cost = selfPenalty(path, [], [rect], [rect])
    expect(cost[tierOf('endpoint-body-ink')]).toBe(0)
    expect(cost[tierOf('border-tracing')]).toBe(100 * COST_QUANTUM)
  })

  it('self term: a perpendicular segment departing from a point on its own node border contributes 0', () => {
    const path = [
      { x: 50, y: -20 },
      { x: 50, y: 0 },
    ]
    expect(selfPenalty(path, [], [], [rect])).toEqual(zeroPenalty())
  })

  it('self term: an endpoint rect fully containing the OTHER endpoint rect is excluded (group-frame exclusion)', () => {
    const inner: Rect = { x: 10, y: 10, w: 20, h: 10 }
    const outer: Rect = { x: 0, y: 0, w: 100, h: 100 }
    const path = [
      { x: -10, y: 15 },
      { x: 110, y: 15 },
    ]
    // outer fully contains inner: outer is excluded, so only inner (strictly
    // crossed at y=15, clipped to inner's x-range [10,30]) is priced.
    expect(selfPenalty(path, [], [], [outer, inner])[tierOf('endpoint-body-ink')]).toBe(
      20 * COST_QUANTUM,
    )
  })

  it('self term: the same geometry WITHOUT containment prices both rects', () => {
    const a: Rect = { x: 0, y: 0, w: 30, h: 20 }
    const b: Rect = { x: 20, y: 0, w: 30, h: 20 }
    const path = [
      { x: -10, y: 10 },
      { x: 60, y: 10 },
    ]
    // Neither fully contains the other: a clips to [0,30] (30px), b clips to
    // [20,50] (30px), summed.
    expect(selfPenalty(path, [], [], [a, b])[tierOf('endpoint-body-ink')]).toBe(60 * COST_QUANTUM)
  })

  it('self term: two DISTINCT but numerically-equal endpoint rects (e.g. a self-loop, or two fully-overlapping same-size nodes) are NOT mutually excluded — this is the exact worst-case overlap the rule prices', () => {
    // Two separate rect objects with identical values — not the same
    // reference — so the `other !== r` identity check does not itself
    // prevent the pair from being compared, exactly as `endpointRectsFor`
    // (spatial-edges.ts) builds two independent rect objects for a
    // self-loop edge (edge.fromNode === edge.toNode) or two same-size
    // fully-overlapping nodes.
    const rectA: Rect = { x: 0, y: 0, w: 50, h: 50 }
    const rectB: Rect = { x: 0, y: 0, w: 50, h: 50 }
    const path = [
      { x: -10, y: 25 },
      { x: 60, y: 25 },
    ]
    // fullyContains(rectA, rectB) is true in both directions under its
    // inclusive comparisons, so a naive symmetric exclusion filter would
    // drop BOTH rects and price 0. Neither PROPERLY contains the other, so
    // both stay in the ink-priced set (chord clipped to [0,50], summed once
    // per rect since inkAlongRects iterates the rect list).
    expect(selfPenalty(path, [], [], [rectA, rectB])[tierOf('endpoint-body-ink')]).toBe(
      2 * 50 * COST_QUANTUM,
    )
  })

  it('self term: zero-width and zero-height endpoint rects contribute 0 (unsatisfiable strict-interior test)', () => {
    const flatH: Rect = { x: 0, y: 0, w: 100, h: 0 }
    const flatW: Rect = { x: 0, y: 0, w: 0, h: 100 }
    const path = [
      { x: -10, y: 0 },
      { x: 110, y: 0 },
    ]
    expect(selfPenalty(path, [], [], [flatH, flatW])[tierOf('endpoint-body-ink')]).toBe(0)
  })

  it('defaults endpointRects to [] when omitted, contributing 0 (no endpoint ink declared)', () => {
    // y=20 sits strictly inside `rect` (top 0, bottom 40) — priced only if
    // this rect is passed as endpointRects, which is omitted here.
    const path = [
      { x: -10, y: 20 },
      { x: 110, y: 20 },
    ]
    expect(selfPenalty(path, [])).toEqual(zeroPenalty())
  })
})

describe('path-reversal', () => {
  const tier = (PENALTY_RULES.find((r) => r.name === 'path-reversal') as PenaltyRule).tier

  it.each([
    [
      'straight',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      0,
    ],
    [
      'clean L',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      0,
    ],
    [
      'Z (right, down, right — never undoes a direction)',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
      0,
    ],
    [
      'U-hook (right, down, left)',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      1,
    ],
    [
      'the reported knot: up, left, down, right — reverses on BOTH axes',
      [
        { x: 233.33333333333331, y: 570 },
        { x: 233.33333333333331, y: 550 },
        { x: 226, y: 550 },
        { x: 226, y: 560 },
        { x: 246, y: 560 },
      ],
      2,
    ],
    ['empty', [], 0],
    ['single point', [{ x: 0, y: 0 }], 0],
    [
      'repeated identical points',
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      0,
    ],
    [
      'a path of only zero-length segments',
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
      0,
    ],
  ] as const)('%s path contributes %i to its declared tier', (_label, path, expected) => {
    const cost = selfPenalty(path, [])
    expect(cost[tier]).toBe(expected)
    expect(cost.every((n) => Number.isFinite(n) && n >= 0)).toBe(true)
  })

  it('pair term is always 0 (self-only rule)', () => {
    const triple = scoreSegmentPair(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    )
    expect(pairPenalty(triple)[tier]).toBe(0)
  })
})

describe('realized-bends', () => {
  it.each([
    [
      'straight',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      0,
    ],
    [
      'L',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      1,
    ],
    [
      'Z',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
      2,
    ],
    ['single-point', [{ x: 0, y: 0 }], 0],
    ['empty', [], 0],
    [
      'zero-length segment',
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      0,
    ],
  ] as const)('%s path contributes %i to tier 6', (_label, path, expected) => {
    const cost = selfPenalty(path, [])
    expect(cost[6]).toBe(expected)
    expect(cost.every((n) => Number.isFinite(n) && n >= 0)).toBe(true)
  })
})

describe('hasRepairableProblem', () => {
  it('is false when the only nonzero tier is the last (realized-bends) tier', () => {
    expect(hasRepairableProblem([0, 0, 0, 0, 0, 0, 5])).toBe(false)
  })

  it.each([
    [[1, 0, 0, 0, 0, 0, 0]],
    [[0, 1, 0, 0, 0, 0, 0]],
    [[0, 0, 1, 0, 0, 0, 0]],
    [[0, 0, 0, 1, 0, 0, 0]],
    [[0, 0, 0, 0, 1, 0, 0]],
    [[0, 0, 0, 0, 0, 1, 0]],
    [[1, 1, 1, 1, 1, 1, 5]],
  ] as const)('is true when a non-final tier is nonzero: %j', (cost) => {
    expect(hasRepairableProblem(cost)).toBe(true)
  })

  it('is false for the zero cost', () => {
    expect(hasRepairableProblem(zeroPenalty())).toBe(false)
  })

  it('is true when the only nonzero tier is border-tracing (repairable, unlike realized-bends)', () => {
    expect(hasRepairableProblem([0, 0, 0, 7, 0, 0, 0])).toBe(true)
  })

  it('is true when the only nonzero tier is endpoint-body-ink (repairable, unlike realized-bends)', () => {
    expect(hasRepairableProblem([0, 0, 0, 0, 7, 0, 0])).toBe(true)
  })

  it('is true when the only nonzero tier is path-reversal (repairable, unlike realized-bends)', () => {
    expect(hasRepairableProblem([0, 0, 0, 0, 0, 7, 0])).toBe(true)
  })

  it('is false when rules is empty (guards Math.max(...[]) === -Infinity)', () => {
    expect(hasRepairableProblem([1, 2, 3], [])).toBe(false)
  })
})

describe('addCost', () => {
  it('sums two cost arrays tier-by-tier with sign=1', () => {
    expect(addCost([1, 2, 3, 4, 5, 6, 7], [10, 20, 30, 40, 50, 60, 70], 1)).toEqual([
      11, 22, 33, 44, 55, 66, 77,
    ])
  })

  it('subtracts b from a tier-by-tier with sign=-1', () => {
    expect(addCost([10, 20, 30, 40, 50, 60, 70], [1, 2, 3, 4, 5, 6, 7], -1)).toEqual([
      9, 18, 27, 36, 45, 54, 63,
    ])
  })

  it('defaults a missing index in either operand to 0', () => {
    const tier1Rule: PenaltyRule = {
      name: 'tier1',
      tier: 1,
      pairTerm: () => 0,
      selfTerm: () => 0,
    }
    // a has no index 1 at all; b does. a[rule.tier] ?? 0 must supply the 0.
    expect(addCost([100], [0, 5], 1, [tier1Rule])).toEqual([0, 5])
  })

  it('composes over a non-default rules array', () => {
    const rule0: PenaltyRule = { name: 'r0', tier: 0, pairTerm: () => 0, selfTerm: () => 0 }
    expect(addCost([7], [3], 1, [rule0])).toEqual([10])
  })
})

describe('lessCost', () => {
  it('compares in tier order even when the rules array is passed out of order', () => {
    const tier0Rule: PenaltyRule = { name: 'r0', tier: 0, pairTerm: () => 0, selfTerm: () => 0 }
    const tier1Rule: PenaltyRule = { name: 'r1', tier: 1, pairTerm: () => 0, selfTerm: () => 0 }
    // Declared out of tier order: tier1 first, tier0 second.
    const outOfOrderRules = [tier1Rule, tier0Rule]
    // tier0: a(5) > b(3) already decides "not less"; tier1 (a=1 < b=100)
    // must never be consulted first, or this would wrongly read true.
    const a = [5, 1]
    const b = [3, 100]
    expect(lessCost(a, b, outOfOrderRules)).toBe(false)
    expect(lessCost(b, a, outOfOrderRules)).toBe(true)
  })
})
