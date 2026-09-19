// The geometric predicates tidy decides membership and settling with, stated
// as what they must be RELATIVE TO EACH OTHER rather than by recomputing what
// they compute — an oracle built out of the code it judges says nothing.
//
// Why it exists: the mutation lane reported ~100 survivors across
// `tidy-units.ts` and three were verified by hand before any of this was
// written. Each could be made and all 1631 canvas-render tests stayed green:
// `usable` could stop filtering non-finite boxes, `mostlyInside` could admit
// a zero-width overlap, and its degenerate-area branch could never be taken.
//
// The `usable` one is the reason this is a property over `tidyNodes` and not
// over the predicate. `tidyNodes` already carries a DEFENSIVE finite check on
// its way out, so removing the filter drops no bad move and looked harmless.
// Measured, it is not: a single non-finite FRAME on a board makes tidy return
// NO MOVES AT ALL — the overlapping boxes beside it stay overlapping, with no
// error anywhere. The output guard converts "every computed position is NaN"
// into "nothing moved", which is the quietest failure a button has.
import { describe, expect, it } from 'vitest'
import { fullyContains } from './layout/edges/edge-rules.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { tidyNodes } from './tidy.js'
import { mostlyInside, type Rect, type TidyNode } from './tidy-units.js'

const coord = fc.integer({ min: -500, max: 500 })
const span = fc.integer({ min: 1, max: 300 })

const rect: fc.Arbitrary<Rect> = fc.record({ x: coord, y: coord, w: span, h: span })

/** A rect with no area — a line or a point, which a drawer can still make. */
const degenerateRect: fc.Arbitrary<Rect> = fc.record({
  x: coord,
  y: coord,
  w: fc.constantFrom(0, 0, 5),
  h: fc.constantFrom(0, 5, 0),
})

/** An `inner` placed strictly inside `outer`, so containment holds by construction. */
const containedPair: fc.Arbitrary<{ outer: Rect; inner: Rect }> = fc
  .tuple(rect, fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat()))
  .map(([outer, [left, top, right, bottom]]) => {
    // Insets that always leave a non-negative box, whatever the draws were.
    const dx = Math.min(left, Math.floor(outer.w / 2))
    const dy = Math.min(top, Math.floor(outer.h / 2))
    const dw = Math.min(right, outer.w - dx)
    const dh = Math.min(bottom, outer.h - dy)
    return {
      outer,
      inner: { x: outer.x + dx, y: outer.y + dy, w: outer.w - dx - dw, h: outer.h - dy - dh },
    }
  })

/**
 * Two rects that share no point, separated on at least one axis by
 * CONSTRUCTION — the generator decides they are disjoint, so nothing here
 * reimplements the overlap arithmetic the predicate does.
 */
const disjointPair: fc.Arbitrary<{ a: Rect; b: Rect }> = fc
  .tuple(
    rect,
    span,
    span,
    fc.nat({ max: 200 }),
    fc.nat({ max: 200 }),
    fc.constantFrom('x', 'y', 'both'),
  )
  .map(([a, w, h, gapX, gapY, axis]) => ({
    a,
    b: {
      x: axis === 'y' ? a.x : a.x + a.w + 1 + gapX,
      y: axis === 'x' ? a.y : a.y + a.h + 1 + gapY,
      w,
      h,
    },
  }))

/**
 * An `inner` STRADDLING one vertical edge of `outer`, with a known part of
 * its width inside and the rest hanging out — wholly inside vertically, so
 * the share that counts is the horizontal one and the generator knows it
 * without computing an intersection.
 *
 * This is the arrangement `mostlyInside` was written for and the one nothing
 * reached: a board of contained boxes and a board of disjoint boxes both
 * leave the majority test itself unexercised, which is why dropping it
 * outright survived the first version of this file.
 */
const straddlePair: fc.Arbitrary<{ outer: Rect; inner: Rect; inside: number }> = fc
  .tuple(rect, fc.integer({ min: 2, max: 300 }), span, fc.nat())
  .map(([outer, w, hRaw, insideRaw]) => {
    const h = Math.max(1, Math.min(hRaw, outer.h))
    // At least 1 inside, at most one less than its own width (so it really
    // hangs out), and never more than the frame is wide.
    const inside = Math.max(1, Math.min(insideRaw % w || 1, w - 1, outer.w))
    return { outer, inner: { x: outer.x + outer.w - inside, y: outer.y, w, h }, inside }
  })

const box = (id: string, r: Rect, frame = false): TidyNode => ({
  id,
  frame,
  x: r.x,
  y: r.y,
  width: r.w,
  height: r.h,
})

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] as const

describe('what tidy may never do, whatever it is handed', () => {
  fcTest.prop(
    [
      fc.array(rect, { minLength: 2, maxLength: 6 }),
      fc.array(fc.nat({ max: 5 }), { minLength: 1, maxLength: 4 }),
      fc.constantFrom(...NON_FINITE),
      fc.boolean(),
    ],
    withDefaults(),
  )(
    'a box no number can describe never changes where the finite ones land',
    (rects, poisonedFields, value, asFrame) => {
      const finite = rects.map((r, i) => box(`n${i}`, r))
      // One extra box, non-finite in whichever fields were drawn. It is a
      // FRAME half the time because that is the case the hand probe found:
      // a NaN frame took the whole board's tidy down to nothing, while a
      // NaN leaf was inert. A property that only ever drew leaves would
      // have reported the filter as unnecessary.
      const bad = box(`bad`, { x: 0, y: 0, w: 100, h: 60 }, asFrame) as {
        -readonly [K in keyof TidyNode]: TidyNode[K]
      }
      const fields = ['x', 'y', 'width', 'height'] as const
      for (const which of poisonedFields) bad[fields[which % fields.length]] = value
      expect(tidyNodes([...finite, bad])).toEqual(tidyNodes(finite))
    },
  )

  fcTest.prop([fc.array(rect, { minLength: 2, maxLength: 6 })], withDefaults())(
    'a board it can read is moved somewhere every number describes',
    (rects) => {
      for (const move of tidyNodes(rects.map((r, i) => box(`n${i}`, r)))) {
        for (const n of [move.x, move.y, move.width, move.height]) {
          if (n !== undefined) expect(Number.isFinite(n)).toBe(true)
        }
      }
    },
  )
})

describe('membership by majority, against containment', () => {
  fcTest.prop([containedPair], withDefaults())(
    'a box a frame CONTAINS is one of its members, area or no area',
    ({ outer, inner }) => {
      // The relationship between the two predicates, which is what makes
      // this an invariant rather than a second implementation: whatever
      // "more than half inside" computes, it can never disagree with "wholly
      // inside". A zero-area box is the case the degenerate branch exists
      // for — half of nothing is nothing, so the majority test alone would
      // answer false for a box sitting squarely in the frame.
      expect(fullyContains(outer, inner)).toBe(true)
      expect(mostlyInside(outer, inner)).toBe(true)
    },
  )

  fcTest.prop([rect, degenerateRect], withDefaults())(
    'a box with no area is a member exactly when it is inside',
    (outer, inner) => {
      expect(mostlyInside(outer, inner)).toBe(fullyContains(outer, inner))
    },
  )

  fcTest.prop([disjointPair], withDefaults())(
    'a frame never claims a box it does not touch',
    ({ a, b }) => {
      // Disjoint by construction, both ways round. This is the one the
      // `&&` between the two overlap spans is load-bearing for: two boxes
      // separated on BOTH axes have a negative span on each, and a product
      // of two negatives is positive — so a predicate that tested the
      // product alone would claim a box diagonally across the canvas.
      expect(mostlyInside(a, b)).toBe(false)
      expect(mostlyInside(b, a)).toBe(false)
    },
  )

  const straddles = { majority: 0, minority: 0, half: 0 }

  fcTest.prop([straddlePair], withDefaults())(
    'a straddler is claimed by the frame it is mostly in, and by no other',
    ({ outer, inner, inside }) => {
      // Said the way the declaration says it — MORE THAN HALF of the box is
      // inside — over a geometry the generator built, rather than by
      // recomputing the overlap the predicate computes.
      //
      // Both directions matter and they are different features. A drawer who
      // puts a box across a frame's edge means it to be in the frame, and
      // before majority membership existed it became its own unit and was
      // hopped clear of the frame entirely. The other way round is what
      // keeps a frame from swallowing a neighbour it clips by a corner.
      const claimed = mostlyInside(outer, inner)
      if (inside * 2 > inner.w) {
        straddles.majority += 1
        expect(claimed).toBe(true)
      } else if (inside * 2 < inner.w) {
        straddles.minority += 1
        expect(claimed).toBe(false)
      } else {
        // Exactly half is not a majority. Pinned rather than left to the
        // reader, because it is the one boundary the wording leaves open.
        straddles.half += 1
        expect(claimed).toBe(false)
      }
    },
  )

  it('drew both sides of the straddle, so neither arm is a claim nothing reached', () => {
    // A property whose interesting arm is never generated reads exactly like
    // one that checked it.
    expect(straddles.majority).toBeGreaterThan(0)
    expect(straddles.minority).toBeGreaterThan(0)
  })

  fcTest.prop([containedPair, fc.nat({ max: 100 }), fc.nat({ max: 100 })], withDefaults())(
    'a frame that grows keeps every member it had',
    ({ outer, inner }, dx, dy) => {
      const bigger = { x: outer.x - dx, y: outer.y - dy, w: outer.w + dx * 2, h: outer.h + dy * 2 }
      if (mostlyInside(outer, inner)) expect(mostlyInside(bigger, inner)).toBe(true)
    },
  )
})
