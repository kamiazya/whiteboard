import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { diagonalInkThrough } from './diagonal-ink.js'

// Pure geometry with a clean invariant, so properties rather than examples
// (the one example, the straight style's retrace, is in edge-rules.test.ts).
const pointArb = fc.record({
  x: fc.integer({ min: -200, max: 200 }),
  y: fc.integer({ min: -200, max: 200 }),
})
const rectArb = fc.record({
  x: fc.integer({ min: -150, max: 150 }),
  y: fc.integer({ min: -150, max: 150 }),
  w: fc.integer({ min: 1, max: 120 }),
  h: fc.integer({ min: 1, max: 120 }),
})
const pathArb = fc.array(pointArb, { minLength: 2, maxLength: 5 })
const rectsArb = fc.array(rectArb, { minLength: 1, maxLength: 4 })

/** The oracle: sample the segment and count what lands strictly inside. */
function sampled(
  path: readonly { x: number; y: number }[],
  rects: readonly { x: number; y: number; w: number; h: number }[],
): number {
  const N = 4000
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    if (a.x === b.x || a.y === b.y) continue
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    for (const r of rects) {
      let inside = 0
      for (let k = 0; k < N; k++) {
        const t = (k + 0.5) / N
        const x = a.x + (b.x - a.x) * t
        const y = a.y + (b.y - a.y) * t
        if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) inside++
      }
      total += (inside / N) * len
    }
  }
  return total
}

describe('diagonalInkThrough', () => {
  fcTest.prop([pathArb, rectsArb], withDefaults({ numRuns: 150 }))(
    'agrees with a sampled estimate of the chord strictly inside each rect',
    (path, rects) => {
      // Two samples of the segment per quantum of tolerance: the estimate is
      // off by at most one sample step per rect per segment.
      const step =
        Math.max(
          ...path
            .slice(1)
            .map((b, i) =>
              Math.hypot(b.x - (path[i] as { x: number }).x, b.y - (path[i] as { y: number }).y),
            ),
        ) / 4000
      const slack = 2 * step * rects.length * (path.length - 1) + 1e-9
      expect(Math.abs(diagonalInkThrough(path, rects) - sampled(path, rects))).toBeLessThanOrEqual(
        slack,
      )
    },
  )

  fcTest.prop([pathArb, rectsArb, pointArb], withDefaults({ numRuns: 150 }))(
    'is equivariant under translation and never longer than the path',
    (path, rects, d) => {
      const moved = diagonalInkThrough(
        path.map((p) => ({ x: p.x + d.x, y: p.y + d.y })),
        rects.map((r) => ({ ...r, x: r.x + d.x, y: r.y + d.y })),
      )
      const ink = diagonalInkThrough(path, rects)
      expect(Math.abs(moved - ink)).toBeLessThan(1e-6)
      const length = path
        .slice(1)
        .reduce(
          (sum, b, i) =>
            sum +
            Math.hypot(b.x - (path[i] as { x: number }).x, b.y - (path[i] as { y: number }).y),
          0,
        )
      expect(ink).toBeGreaterThanOrEqual(0)
      expect(ink).toBeLessThanOrEqual(length * rects.length + 1e-9)
    },
  )

  fcTest.prop(
    [fc.array(fc.integer({ min: -200, max: 200 }), { minLength: 2, maxLength: 5 }), rectsArb],
    withDefaults({ numRuns: 80 }),
  )('reads nothing off an axis-aligned path, which the axis terms own', (xs, rects) => {
    const y = 7
    const horizontal = xs.map((x) => ({ x, y }))
    expect(diagonalInkThrough(horizontal, rects)).toBe(0)
    const vertical = xs.map((v) => ({ x: y, y: v }))
    expect(diagonalInkThrough(vertical, rects)).toBe(0)
  })
})
