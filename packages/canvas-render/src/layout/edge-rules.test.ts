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
  it('declares exactly the six named rules from decision #10, in order', () => {
    expect(SIDE_PREFERENCE_RULES.map((r) => r.name)).toEqual([
      'zero-bend-facing-first',
      'dominant-axis-first',
      'l-pair-crowding-tie-break',
      'u-hook-when-degenerate',
      'gap-valid-opposing-before-invalid',
      'incumbent-wins-ties',
    ])
  })
})

describe('PENALTY_RULES', () => {
  it('declares the six named tiers in tier order, realized-bends last', () => {
    expect(PENALTY_RULES.map((r) => r.name)).toEqual([
      'overlap-and-intrusion',
      'illegibility',
      'crossings',
      'border-tracing',
      'endpoint-body-ink',
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
    expect(pairPenalty(triple)).toEqual([10 * COST_QUANTUM, 0, 0, 0, 0, 0])
  })

  it('self term: a path retracing its own ink contributes the quantized retrace length to tier 0', () => {
    // Out to (20,0), back to (5,0): the [20,0]-[5,0] segment retraces
    // [0,0]-[20,0] over x in [5,20], a 15px overlap.
    const path = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 5, y: 0 },
    ]
    expect(selfPenalty(path, [])).toEqual([15 * COST_QUANTUM, 0, 0, 0, 0, 1])
  })

  it('self term: a segment through a foreign rect interior contributes the quantized chord length to tier 0', () => {
    const path = [
      { x: -10, y: 50 },
      { x: 110, y: 50 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual([100 * COST_QUANTUM, 0, 0, 0, 0, 0])
  })

  it('self term: a segment riding exactly on the rect boundary contributes 0 (grazing exclusion)', () => {
    const path = [
      { x: -10, y: 0 },
      { x: 110, y: 0 },
    ]
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(selfPenalty(path, [rect])).toEqual(zeroPenalty())
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
    expect(pairPenalty(triple)).toEqual([0, 1, 1, 0, 0, 0])
  })

  it('pair term: a transversal crossing far from every end contributes 0 to tier 1', () => {
    const triple = scoreSegmentPair(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    )
    expect(pairPenalty(triple)).toEqual([0, 0, 1, 0, 0, 0])
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
    expect(pairPenalty(triple)).toEqual([0, 0, 1, 0, 0, 0])
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

  it('self term: a horizontal segment lying along the rect top contributes the quantized clipped overlap length to tier 3', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(selfPenalty(path, [], [rect])).toEqual([0, 0, 0, 100 * COST_QUANTUM, 0, 0])
  })

  it('self term: a vertical segment lying along the rect right side contributes the quantized overlap length to tier 3', () => {
    const path = [
      { x: 100, y: 0 },
      { x: 100, y: 40 },
    ]
    expect(selfPenalty(path, [], [rect])).toEqual([0, 0, 0, 40 * COST_QUANTUM, 0, 0])
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
    expect(selfPenalty(path, [], [rect])[3]).toBe(100 * COST_QUANTUM)
  })

  it('self term: a zero-height rect is charged once, not twice, for a segment lying on it', () => {
    const flat: Rect = { x: 0, y: 0, w: 100, h: 0 }
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(selfPenalty(path, [], [flat])[3]).toBe(100 * COST_QUANTUM)
  })

  it('self term: fires against the path’s OWN endpoint node, unlike foreignBodies which excludes it', () => {
    // foreignBodies deliberately excludes an edge's own endpoints (tunnel
    // check); nodeBorders deliberately does NOT — the whole point is
    // pricing a segment riding the SOURCE node's own border.
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(selfPenalty(path, [rect], [rect])).toEqual([0, 0, 0, 100 * COST_QUANTUM, 0, 0])
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

  it('self term: a horizontal segment strictly between the rect top and bottom contributes the quantized clipped chord length to tier 4', () => {
    const path = [
      { x: -10, y: 20 },
      { x: 110, y: 20 },
    ]
    expect(selfPenalty(path, [], [], [rect])).toEqual([0, 0, 0, 0, 100 * COST_QUANTUM, 0])
  })

  it('self term: a vertical segment strictly between the rect left and right contributes the quantized clipped chord length to tier 4', () => {
    const path = [
      { x: 50, y: -10 },
      { x: 50, y: 50 },
    ]
    expect(selfPenalty(path, [], [], [rect])).toEqual([0, 0, 0, 0, 40 * COST_QUANTUM, 0])
  })

  it('self term: a segment riding exactly on the border contributes 0 to this tier (border-tracing prices it instead, no double-charge)', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    const cost = selfPenalty(path, [], [rect], [rect])
    expect(cost[4]).toBe(0)
    expect(cost[3]).toBe(100 * COST_QUANTUM)
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
    expect(selfPenalty(path, [], [], [outer, inner])[4]).toBe(20 * COST_QUANTUM)
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
    expect(selfPenalty(path, [], [], [a, b])[4]).toBe(60 * COST_QUANTUM)
  })

  it('self term: zero-width and zero-height endpoint rects contribute 0 (unsatisfiable strict-interior test)', () => {
    const flatH: Rect = { x: 0, y: 0, w: 100, h: 0 }
    const flatW: Rect = { x: 0, y: 0, w: 0, h: 100 }
    const path = [
      { x: -10, y: 0 },
      { x: 110, y: 0 },
    ]
    expect(selfPenalty(path, [], [], [flatH, flatW])[4]).toBe(0)
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
  ] as const)('%s path contributes %i to tier 5', (_label, path, expected) => {
    const cost = selfPenalty(path, [])
    expect(cost[5]).toBe(expected)
    expect(cost.every((n) => Number.isFinite(n) && n >= 0)).toBe(true)
  })
})

describe('hasRepairableProblem', () => {
  it('is false when the only nonzero tier is the last (realized-bends) tier', () => {
    expect(hasRepairableProblem([0, 0, 0, 0, 0, 5])).toBe(false)
  })

  it.each([
    [[1, 0, 0, 0, 0, 0]],
    [[0, 1, 0, 0, 0, 0]],
    [[0, 0, 1, 0, 0, 0]],
    [[0, 0, 0, 1, 0, 0]],
    [[0, 0, 0, 0, 1, 0]],
    [[1, 1, 1, 1, 1, 5]],
  ] as const)('is true when a non-final tier is nonzero: %j', (cost) => {
    expect(hasRepairableProblem(cost)).toBe(true)
  })

  it('is false for the zero cost', () => {
    expect(hasRepairableProblem(zeroPenalty())).toBe(false)
  })

  it('is true when the only nonzero tier is border-tracing (repairable, unlike realized-bends)', () => {
    expect(hasRepairableProblem([0, 0, 0, 7, 0, 0])).toBe(true)
  })

  it('is true when the only nonzero tier is endpoint-body-ink (repairable, unlike realized-bends)', () => {
    expect(hasRepairableProblem([0, 0, 0, 0, 7, 0])).toBe(true)
  })

  it('is false when rules is empty (guards Math.max(...[]) === -Infinity)', () => {
    expect(hasRepairableProblem([1, 2, 3], [])).toBe(false)
  })
})

describe('addCost', () => {
  it('sums two cost arrays tier-by-tier with sign=1', () => {
    expect(addCost([1, 2, 3, 4, 5, 6], [10, 20, 30, 40, 50, 60], 1)).toEqual([
      11, 22, 33, 44, 55, 66,
    ])
  })

  it('subtracts b from a tier-by-tier with sign=-1', () => {
    expect(addCost([10, 20, 30, 40, 50, 60], [1, 2, 3, 4, 5, 6], -1)).toEqual([
      9, 18, 27, 36, 45, 54,
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
