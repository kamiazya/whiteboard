import { beforeAll, describe, expect, it } from 'vitest'
import type { FontDescriptor, MeasureText } from '../measure.js'

/**
 * What a `MeasureText` promises beyond its signature, for every realm that
 * supplies one against the vendored Roboto family: opentype.js on Node,
 * Canvas 2D in the browser. They are two implementations of one seam whose
 * whole value is that a canvas wraps at the same place in the editor and in
 * `wb_scene_render`, so the agreement is what is pinned, not either
 * implementation's own arithmetic.
 *
 * The expected numbers are the vendored faces' design-unit advances, not a
 * measurer's output: a measurer that produced them by calling another
 * measurer would agree with it by construction.
 */

const FAMILY = 'Roboto'
const SIZE_PX = 16

// Roboto's hhea table: ascender 1900, descender -500, lineGap 0, in 2048
// units per em. Canvas 2D reports font bounding boxes rounded to whole
// pixels (13 and 3 at 14px against 12.988 and 3.418), so a vertical metric
// is judged to the half pixel a rounding to the nearest integer can move
// it — tighter would fail a correct browser, looser would admit a wrong face.
const ASCENT_EM = 1900 / 2048
const DESCENT_EM = 500 / 2048
const VERTICAL_TOLERANCE_PX = 0.5

// Advances are fractional on both sides (measured: Chromium returns the
// design-unit sum, not a pixel-snapped one), so a hundredth of a pixel
// separates "the same advance" from "a different face" with room to spare:
// the nearest real difference, bold against regular, is over a pixel.
const ADVANCE_TOLERANCE_PX = 0.01

const SAMPLE = 'Hamburgefonstiv'
// Unkerned advances of SAMPLE at SIZE_PX, summed from each face's hmtx.
const SAMPLE_ADVANCE_PX = {
  regular: 123.5,
  bold: 125.0625,
  italic: 119.796875,
  boldItalic: 121.3203125,
} as const

type Emphasis = keyof typeof SAMPLE_ADVANCE_PX

const EMPHASIS_DESCRIPTOR: Record<Emphasis, Pick<FontDescriptor, 'weight' | 'style'>> = {
  regular: { weight: 400, style: 'normal' },
  bold: { weight: 700, style: 'normal' },
  italic: { weight: 400, style: 'italic' },
  boldItalic: { weight: 700, style: 'italic' },
}

function descriptor(overrides: Partial<FontDescriptor> = {}): FontDescriptor {
  return {
    family: FAMILY,
    fallbackChain: [],
    weight: 400,
    style: 'normal',
    sizePx: SIZE_PX,
    ...overrides,
  }
}

export function describeMeasureTextConformance(
  /** Resolves once the realm holds every face the measurer will be asked for. */
  makeMeasure: () => MeasureText | Promise<MeasureText>,
): void {
  let measure: MeasureText
  beforeAll(async () => {
    measure = await makeMeasure()
  })

  describe('the contract', () => {
    it('measures an empty string as nothing', () => {
      expect(measure('', descriptor()).advanceWidth).toBe(0)
    })

    it('answers finite, non-negative metrics', () => {
      for (const value of Object.values(measure(SAMPLE, descriptor()))) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    })

    it('scales the advance linearly with the font size', () => {
      const small = measure(SAMPLE, descriptor({ sizePx: 16 })).advanceWidth
      const large = measure(SAMPLE, descriptor({ sizePx: 48 })).advanceWidth
      expect(large).toBeCloseTo(small * 3, 1)
    })
  })

  describe('advance', () => {
    it('is additive across a split, so a seam between two runs costs nothing', () => {
      // A kerning pair at the seam is what breaks this: the pair exists only
      // once the two runs are measured as one string, and layout measures a
      // line's words, a wrapped line and the whole text interchangeably.
      for (const [a, b] of [
        ['AAA', 'VVV'],
        ['To', 'Yo'],
        ['Ratio AV', 'AT war'],
      ] as const) {
        const whole = measure(a + b, descriptor()).advanceWidth
        const parts = measure(a, descriptor()).advanceWidth + measure(b, descriptor()).advanceWidth
        expect(Math.abs(whole - parts), `${JSON.stringify(a)} + ${JSON.stringify(b)}`).toBeLessThan(
          ADVANCE_TOLERANCE_PX,
        )
      }
    })

    it('is the sum of the face advances, with no kerning applied', () => {
      expect(measure('AVATAR', descriptor()).advanceWidth).toBeCloseTo(60.90625, 1)
    })

    it('matches the regular face design advance', () => {
      const { advanceWidth } = measure(SAMPLE, descriptor())
      expect(Math.abs(advanceWidth - SAMPLE_ADVANCE_PX.regular)).toBeLessThan(ADVANCE_TOLERANCE_PX)
    })
  })

  describe('emphasis', () => {
    it('measures bold wider than regular', () => {
      const regular = measure(SAMPLE, descriptor()).advanceWidth
      const bold = measure(SAMPLE, descriptor({ weight: 700 })).advanceWidth
      expect(bold).toBeGreaterThan(regular)
    })

    it('measures italic differently from regular', () => {
      const regular = measure(SAMPLE, descriptor()).advanceWidth
      const italic = measure(SAMPLE, descriptor({ style: 'italic' })).advanceWidth
      expect(italic).not.toBeCloseTo(regular, 1)
    })

    it.each(
      Object.keys(SAMPLE_ADVANCE_PX) as Emphasis[],
    )('matches the %s face design advance', (emphasis) => {
      const { advanceWidth } = measure(SAMPLE, descriptor(EMPHASIS_DESCRIPTOR[emphasis]))
      expect(Math.abs(advanceWidth - SAMPLE_ADVANCE_PX[emphasis])).toBeLessThan(
        ADVANCE_TOLERANCE_PX,
      )
    })
  })

  describe('vertical metrics', () => {
    it.each([
      { sizePx: 14 },
      { sizePx: 16 },
      { sizePx: 40 },
    ])('are Roboto hhea scaled, at $sizePx px', ({ sizePx }) => {
      const metrics = measure(SAMPLE, descriptor({ sizePx }))
      expect(Math.abs(metrics.ascent - ASCENT_EM * sizePx)).toBeLessThanOrEqual(
        VERTICAL_TOLERANCE_PX,
      )
      expect(Math.abs(metrics.descent - DESCENT_EM * sizePx)).toBeLessThanOrEqual(
        VERTICAL_TOLERANCE_PX,
      )
    })
  })
}
