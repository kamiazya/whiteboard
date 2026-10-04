import type { FontDescriptor, MeasureText, TextMetrics } from '@kamiazya/whiteboard-canvas-render'
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'

function fontCss(font: FontDescriptor): string {
  const family = [font.family, ...font.fallbackChain].filter((name) => name.length > 0).join(', ')
  return `${font.style} ${font.weight} ${font.sizePx}px ${family || 'sans-serif'}`
}

/** Metrics must always be finite/non-negative per MeasureText's documented contract. */
function clampMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

const EMPTY_METRICS: TextMetrics = { advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 }

// Typical Latin ascent/descent split of the em box, used both when the Canvas
// 2D metrics omit the bounding-box fields and by the no-context fallback.
const ASCENT_RATIO = 0.8
const DESCENT_RATIO = 0.2

function measureWithContext(
  ctx: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  text: string,
  font: FontDescriptor,
): TextMetrics {
  if (text === '') return EMPTY_METRICS
  ctx.font = fontCss(font)
  const metrics = ctx.measureText(text)
  const ascent = clampMetric(
    metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? font.sizePx * ASCENT_RATIO,
  )
  const descent = clampMetric(
    metrics.fontBoundingBoxDescent ??
      metrics.actualBoundingBoxDescent ??
      font.sizePx * DESCENT_RATIO,
  )
  return { advanceWidth: clampMetric(metrics.width), ascent, descent, lineGap: 0 }
}

/**
 * The browser half of canvas-render's injected MeasureText seam
 * (D3: canvas-render stays DOM-free, canvas-viewer supplies the browser
 * implementation). Lazily creates a single offscreen <canvas> 2D context
 * and reuses it across calls.
 */
/**
 * A 2D context to measure in: `<canvas>` on a window, `OffscreenCanvas` on a
 * worker, which has no `document`.
 *
 * Both were verified to return IDENTICAL metrics in Chromium for the same
 * registered face — that parity is what allows layout to move off the main
 * thread at all, and `layout-worker-parity.browser.test.tsx` is the guard
 * that keeps it true. A realm that can produce neither falls back to the
 * ratio estimate, exactly as before.
 */
type MeasuringContext = Pick<
  CanvasRenderingContext2D,
  'font' | 'measureText' | 'fontKerning' | 'textRendering'
>

/**
 * A context that measures the way the Node measurer does: the face's design
 * advances, summed glyph by glyph.
 *
 * Both settings exist because the default is a platform decision, not the
 * font's. Kerning is on by default, so `advance(a + b)` is not
 * `advance(a) + advance(b)` — the property the Node measurer turns kerning
 * off to keep, and what lets layout measure words, lines and wholes
 * interchangeably (`AVATAR` 58.0 against 60.9 unkerned). And on Linux
 * Chromium the default hints glyph advances to whole pixels: Roboto Regular
 * measured 122 for a string whose design advance is 123.5, so every wrap
 * position drifted by up to half a pixel per glyph. `geometricPrecision`
 * switches that to the unhinted advances, which are also what resvg paints.
 * A browser that does not know either property ignores the assignment.
 */
function configureForLayout(ctx: MeasuringContext): MeasuringContext {
  ctx.fontKerning = 'none'
  ctx.textRendering = 'geometricPrecision'
  return ctx
}

function createMeasuringContext(): MeasuringContext | null {
  try {
    if (typeof document !== 'undefined') {
      const ctx = document.createElement('canvas').getContext('2d')
      return ctx === null ? null : configureForLayout(ctx)
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')
      return ctx === null ? null : configureForLayout(ctx as MeasuringContext)
    }
  } catch {
    return null
  }
  return null
}

export function createBrowserMeasureText(): MeasureText {
  let context: MeasuringContext | null | undefined

  const getContext = (): MeasuringContext | null => {
    if (context === undefined) context = createMeasuringContext()
    return context
  }

  return (text: string, font: FontDescriptor): TextMetrics => {
    const ctx = getContext()
    return ctx ? measureWithContext(ctx, text, font) : constantRatioMeasureText(text, font)
  }
}
