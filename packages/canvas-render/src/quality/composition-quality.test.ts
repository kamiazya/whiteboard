// The composition SCOREBOARD (ADR-0032): what each corpus board hands its
// reader, pinned EXACTLY, beside the drawing scoreboard rather than inside
// it. An improvement has to be as loud as a regression, and whoever moves a
// number says why in the diff.
//
// What these columns may be read to mean is fixed by the ADR: the
// composition a drawing hands its reader, never that it was understood.
// `contrast` (treatments, roles) is REPORTED-ONLY — it is pinned so a later
// reading has a number, and it may not be cited for or against a change.
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { constantRatioMeasureText } from '../measure.js'
import { DRAWING_CORPUS } from '../test-utils/drawing-corpus.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { type CompositionScore, scoreComposition } from './composition-score.js'

const measure = constantRatioMeasureText
const appearance = createSpatialTheme({ mode: 'light' })
const scores = new Map(
  DRAWING_CORPUS.map((c) => [
    c.name,
    scoreComposition(c.canvas, layoutSpatialCanvas(c.canvas, { measure, appearance })),
  ]),
)
const of = (name: string) => scores.get(name) as CompositionScore

describe('composition quality across the corpus', () => {
  it('reports every board', () => {
    expect(Object.fromEntries(scores)).toEqual({
      'architecture/reference': {
        // Three frames, none of them spaced against its own grouping, and
        // the tightest composition on the corpus: every element on a shared
        // line, three elements to a line, one gap size and one box size.
        groups: 3,
        apart: 0,
        worstRatio: 0.25,
        guides: 20,
        offGuide: 0,
        perGuide: 3,
        widths: 1,
        heights: 1,
        gaps: 1,
        treatments: 2,
        roles: 4,
      },
      'architecture/drafted': {
        // The same diagram drawn carelessly, and every owed column says so:
        // one element on no shared line, fewer elements per line, five gap
        // sizes where the reference spends one.
        groups: 3,
        apart: 0,
        worstRatio: 0.46,
        guides: 16,
        offGuide: 1,
        perGuide: 2.69,
        widths: 1,
        heights: 1,
        gaps: 5,
        treatments: 2,
        roles: 4,
      },
      'architecture/tidied': {
        // The instrument's first finding, and it is about TIDY. Tidy clears
        // the draft's off-guide element and three of its gap sizes — and
        // leaves one frame spaced against its own grouping, which neither
        // the reference nor the draft owes. Services is stretched to hold a
        // member at its right edge, so the widest gap INSIDE it (168px) is
        // wider than the clearance from its members to the boxes in the
        // frame below (150px): a reader groups by proximity, and the
        // picture now argues with the frame. Recorded here as an owe rather
        // than fixed in the same increment that first measured it.
        groups: 3,
        apart: 1,
        worstRatio: 1.4,
        guides: 16,
        offGuide: 0,
        perGuide: 2.63,
        widths: 1,
        heights: 1,
        gaps: 4,
        treatments: 2,
        roles: 4,
      },
      'sequence/reference': {
        // No frame, so nothing declares a group and proximity is silent —
        // the blind spot ADR-0032 names, pinned rather than papered over.
        groups: 0,
        apart: 0,
        worstRatio: 0,
        guides: 9,
        offGuide: 0,
        perGuide: 2.78,
        widths: 1,
        heights: 2,
        gaps: 3,
        treatments: 1,
        roles: 2,
      },
      'sequence/drafted': {
        groups: 0,
        apart: 0,
        worstRatio: 0,
        guides: 6,
        offGuide: 1,
        perGuide: 2.33,
        widths: 1,
        heights: 2,
        gaps: 5,
        treatments: 1,
        roles: 2,
      },
      'sequence/tidied': {
        // Tidy separates the draft's overlapping pair and pays two elements
        // off every shared line doing it — the alignment column's own
        // version of the drawing score's price, on a board where tidy has
        // no frame to work within.
        groups: 0,
        apart: 0,
        worstRatio: 0,
        guides: 6,
        offGuide: 2,
        perGuide: 2.67,
        widths: 1,
        heights: 2,
        gaps: 4,
        treatments: 1,
        roles: 2,
      },
      'fixture/architecture': {
        groups: 1,
        apart: 0,
        worstRatio: 0.19,
        guides: 11,
        offGuide: 0,
        perGuide: 2.36,
        widths: 1,
        heights: 1,
        gaps: 3,
        treatments: 2,
        roles: 4,
      },
      'lane/architecture': {
        groups: 3,
        apart: 0,
        worstRatio: 0.22,
        guides: 20,
        offGuide: 0,
        perGuide: 3,
        widths: 1,
        heights: 1,
        gaps: 1,
        treatments: 2,
        roles: 4,
      },
      'lane/architecture-tidied': {
        // Tidy's row order and its margin anchor, read on the composition
        // axis: one more shared line and one more gap size than the board it
        // tidied, and no group spaced against itself.
        groups: 3,
        apart: 0,
        worstRatio: 0.29,
        guides: 21,
        offGuide: 0,
        perGuide: 2.71,
        widths: 1,
        heights: 1,
        gaps: 2,
        treatments: 2,
        roles: 4,
      },
      'lane/insert': {
        // The inserted box brings a second width with it, which is what
        // making room for it costs the repetition column.
        groups: 1,
        apart: 0,
        worstRatio: 0.19,
        guides: 12,
        offGuide: 0,
        perGuide: 2.58,
        widths: 2,
        heights: 1,
        gaps: 4,
        treatments: 2,
        roles: 4,
      },
      'lane/insert-roomy': {
        groups: 1,
        apart: 0,
        worstRatio: 0.19,
        guides: 11,
        offGuide: 0,
        perGuide: 2.64,
        widths: 1,
        heights: 1,
        gaps: 4,
        treatments: 2,
        roles: 4,
      },
    })
  })

  // The calibration that makes the numbers above believable: the pairs a
  // person would order with confidence, ordered the same way by every owed
  // column. `contrast` is excluded by ADR-0032 — it is reported, not owed.
  it('every reference hands its reader a better composition than its own draft', () => {
    for (const name of ['architecture', 'sequence']) {
      const reference = of(`${name}/reference`)
      const draft = of(`${name}/drafted`)
      expect(reference.apart, name).toBeLessThanOrEqual(draft.apart)
      expect(reference.worstRatio, name).toBeLessThanOrEqual(draft.worstRatio)
      expect(reference.offGuide, name).toBeLessThanOrEqual(draft.offGuide)
      expect(reference.perGuide, name).toBeGreaterThanOrEqual(draft.perGuide)
      expect(reference.widths, name).toBeLessThanOrEqual(draft.widths)
      expect(reference.heights, name).toBeLessThanOrEqual(draft.heights)
      expect(reference.gaps, name).toBeLessThanOrEqual(draft.gaps)
    }
  })

  it('tidy buys repetition and alignment, and is NOT assumed to buy proximity', () => {
    // Deliberately not the drawing score's "tidy never adds debt". Tidy
    // moves boxes to separate them, and the architecture board shows what
    // that can cost a frame's internal spacing — so the promise made here is
    // the one the measurements support, and the exception is named.
    for (const name of ['architecture', 'sequence']) {
      const draft = of(`${name}/drafted`)
      const tidied = of(`${name}/tidied`)
      expect(tidied.gaps, name).toBeLessThanOrEqual(draft.gaps)
      expect(tidied.widths, name).toBeLessThanOrEqual(draft.widths)
    }
    expect(of('architecture/tidied').offGuide).toBeLessThan(of('architecture/drafted').offGuide)
    // The exception, pinned so it cannot be lost: the tidied architecture
    // board owes a group its draft does not.
    expect(of('architecture/tidied').apart).toBeGreaterThan(of('architecture/drafted').apart)
  })
})
