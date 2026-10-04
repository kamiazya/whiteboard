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
// units per em. Canvas 2D reports font bounding boxes snapped to whole
// pixels, and the snap is not a rounding to nearest (Chromium answers 12 and
// 4 at 14px for 12.988 and 3.418), so a vertical metric is judged to a pixel.
// That is a plausibility bound on the line box, not a check of the face — the
// advances below are the face check.
const ASCENT_EM = 1900 / 2048
const DESCENT_EM = 500 / 2048
const VERTICAL_TOLERANCE_PX = 1

// A measurer that asks for unhinted, unkerned advances returns the face's
// design-unit sum, fractions included. A hundredth of a pixel therefore
// separates "the same advance" from "a different face" with room to spare:
// the smallest real difference, bold against regular, is over a pixel. Default
// Chromium on Linux hints advances to whole pixels (122 for 123.5), which is
// exactly what this tolerance is here to refuse.
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

export interface MeasureTextConformanceOptions {
  /**
   * A realm that holds the Regular face alone leaves bold and italic to the
   * platform, which synthesises them at the Regular advance. Stating why, with
   * the measured cost, ledgers that as a known gap instead of failing it: the
   * emphasis assertions then pin the synthesis itself, and go red the day the
   * faces arrive so the entry cannot outlive the gap.
   */
  readonly synthesisedEmphasis?: string
}

/** The measurer under test, read at run time: it exists only after `beforeAll`. */
type MeasureOf = () => MeasureText

function contractCases(measureOf: MeasureOf): void {
  describe('the contract', () => {
    it('measures an empty string as nothing', () => {
      expect(measureOf()('', descriptor()).advanceWidth).toBe(0)
    })

    it('answers finite, non-negative metrics', () => {
      for (const value of Object.values(measureOf()(SAMPLE, descriptor()))) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    })

    it('scales the advance linearly with the font size', () => {
      const small = measureOf()(SAMPLE, descriptor({ sizePx: 16 })).advanceWidth
      const large = measureOf()(SAMPLE, descriptor({ sizePx: 48 })).advanceWidth
      expect(large).toBeCloseTo(small * 3, 1)
    })
  })
}

function advanceCases(measureOf: MeasureOf): void {
  const advance = (text: string): number => measureOf()(text, descriptor()).advanceWidth

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
        expect(
          Math.abs(advance(a + b) - (advance(a) + advance(b))),
          `${JSON.stringify(a)} + ${JSON.stringify(b)}`,
        ).toBeLessThan(ADVANCE_TOLERANCE_PX)
      }
    })

    it('is the sum of the face advances, with no kerning applied', () => {
      expect(Math.abs(advance('AVATAR') - 60.90625)).toBeLessThan(ADVANCE_TOLERANCE_PX)
    })

    it('matches the regular face design advance', () => {
      expect(Math.abs(advance(SAMPLE) - SAMPLE_ADVANCE_PX.regular)).toBeLessThan(
        ADVANCE_TOLERANCE_PX,
      )
    })
  })
}

function emphasisCases(measureOf: MeasureOf, synthesisedEmphasis: string | undefined): void {
  const emphases = Object.keys(SAMPLE_ADVANCE_PX) as Emphasis[]
  const advanceOf = (emphasis: Emphasis): number =>
    measureOf()(SAMPLE, descriptor(EMPHASIS_DESCRIPTOR[emphasis])).advanceWidth

  if (synthesisedEmphasis !== undefined) {
    describe('emphasis (known gap: synthesised)', () => {
      it.each(
        emphases.filter((emphasis) => emphasis !== 'regular'),
      )('measures %s at the regular advance, so the gap is still open', (emphasis) => {
        expect(
          Math.abs(advanceOf(emphasis) - advanceOf('regular')),
          `${synthesisedEmphasis} — if ${emphasis} now has its own face, drop the ledger entry`,
        ).toBeLessThan(ADVANCE_TOLERANCE_PX)
      })
    })
    return
  }

  describe('emphasis', () => {
    it('measures bold wider than regular', () => {
      expect(advanceOf('bold')).toBeGreaterThan(advanceOf('regular'))
    })

    it('measures italic differently from regular', () => {
      expect(advanceOf('italic')).not.toBeCloseTo(advanceOf('regular'), 1)
    })

    it.each(emphases)('matches the %s face design advance', (emphasis) => {
      expect(Math.abs(advanceOf(emphasis) - SAMPLE_ADVANCE_PX[emphasis])).toBeLessThan(
        ADVANCE_TOLERANCE_PX,
      )
    })
  })
}

function verticalCases(measureOf: MeasureOf): void {
  describe('vertical metrics', () => {
    it.each([
      { sizePx: 14 },
      { sizePx: 16 },
      { sizePx: 40 },
    ])('are Roboto hhea scaled, at $sizePx px', ({ sizePx }) => {
      const metrics = measureOf()(SAMPLE, descriptor({ sizePx }))
      expect(Math.abs(metrics.ascent - ASCENT_EM * sizePx)).toBeLessThanOrEqual(
        VERTICAL_TOLERANCE_PX,
      )
      expect(Math.abs(metrics.descent - DESCENT_EM * sizePx)).toBeLessThanOrEqual(
        VERTICAL_TOLERANCE_PX,
      )
    })
  })
}

export function describeMeasureTextConformance(
  /** Resolves once the realm holds every face the measurer will be asked for. */
  makeMeasure: () => MeasureText | Promise<MeasureText>,
  options: MeasureTextConformanceOptions = {},
): void {
  let measure: MeasureText | undefined
  beforeAll(async () => {
    measure = await makeMeasure()
  })
  const measureOf: MeasureOf = () => {
    if (measure === undefined) throw new Error('the measurer is built in beforeAll')
    return measure
  }

  contractCases(measureOf)
  advanceCases(measureOf)
  emphasisCases(measureOf, options.synthesisedEmphasis)
  verticalCases(measureOf)
}
