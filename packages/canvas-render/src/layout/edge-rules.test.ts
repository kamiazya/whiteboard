import { describe, expect, it } from 'vitest'
import {
  dominantAxisOrder,
  type PreferenceRule,
  type Rect,
  SIDE_PREFERENCE_RULES,
  shouldAdoptCandidate,
  ZERO_LANE_MIN_OVERLAP_PX,
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
