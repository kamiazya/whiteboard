import {
  describeMeasure,
  type FontDescriptor,
  type MeasureText,
  type TextMetrics,
} from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'

/**
 * Names a test's measurer as the HOST measurer, the way the page's canvas
 * measurer is named: a realm with the Rust core installed hands it the
 * function and the core asks it mid-layout through its host import. A
 * measurer named nothing cannot be handed to the core at all, and a layout
 * given one throws `CoreUnaskable` — the core answers every layout here, so
 * there is no TypeScript for it to fall back to. Returns `measure` itself, so
 * a `vi.fn` keeps its call record.
 */
export function hostMeasure<M extends MeasureText>(measure: M): M {
  describeMeasure(measure, { kind: 'host' })
  return measure
}

/**
 * Deterministic, ratio-based `MeasureText` for tests where geometry is not
 * the concern (that belongs to a `.browser.test.tsx` using a real Canvas 2D
 * context). A test that wants canvas-render's own measurers imports them from
 * `@kamiazya/whiteboard-canvas-render/test-utils`; this one differs from
 * `createFakeMeasure` in its line gap (none) and in measuring a blank string
 * as zero-sized, so moving its callers over means re-deriving their numbers.
 * It is named as the host measurer (`hostMeasure`).
 */
export const fakeMeasure: MeasureText = hostMeasure(
  (text: string, font: FontDescriptor): TextMetrics => {
    if (text === '') return { advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 }
    return {
      advanceWidth: text.length * font.sizePx * 0.6,
      ascent: font.sizePx * 0.8,
      descent: font.sizePx * 0.2,
      lineGap: 0,
    }
  },
)

/**
 * A fixed 30px advance per string with a 10/2 ascent and descent, named as the
 * host measurer: the editor tests that assert in those numbers share it.
 */
export const fixedEditorMeasure: MeasureText = hostMeasure(
  createFixedMeasure({ advance: 30, ascent: 10, descent: 2 }),
)
