import { canvasColorSchema } from '@kamiazya/whiteboard-model'
import { STROKE_WIDTHS } from '@kamiazya/whiteboard-plugin-visual'
import { z } from 'zod'

/**
 * What the Draw tool lays its next stroke down with: a colour (absent is the
 * theme's own ink) and a weight. The colour is the line's own `color`, the
 * field a line's menu already writes, so a pen colour and a recolour are one
 * value in one place.
 */
const penStyleSchema = z.object({
  color: canvasColorSchema.optional(),
  width: z.enum(STROKE_WIDTHS),
})

export type PenStyle = z.infer<typeof penStyleSchema>

export const DEFAULT_PEN: PenStyle = { width: 'thin' }

const PEN_KEY = 'wb.pen'

/**
 * The pen this tab last drew with, across every canvas: a pen is the
 * person's, not the document's, and a session is how long a choice of ink
 * is expected to last. Anything unreadable is the default pen.
 */
export function readPen(): PenStyle {
  try {
    const stored = sessionStorage.getItem(PEN_KEY)
    if (stored === null) return DEFAULT_PEN
    const parsed = penStyleSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : DEFAULT_PEN
  } catch {
    // Storage blocked, or a payload that is not JSON: the default pen is a
    // complete fallback.
    return DEFAULT_PEN
  }
}

export function writePen(pen: PenStyle): void {
  try {
    sessionStorage.setItem(PEN_KEY, JSON.stringify(pen))
  } catch {
    // Losing the preference is survivable; failing the pick is not.
  }
}
