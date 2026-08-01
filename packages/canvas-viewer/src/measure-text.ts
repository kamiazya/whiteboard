import type { FontDescriptor, MeasureText, TextMetrics } from '@kamiazya/whiteboard-canvas-render'

function fontCss(font: FontDescriptor): string {
  const family = [font.family, ...font.fallbackChain].filter((name) => name.length > 0).join(', ')
  return `${font.style} ${font.weight} ${font.sizePx}px ${family || 'sans-serif'}`
}

/** Metrics must always be finite/non-negative per MeasureText's documented contract. */
function clampMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

const EMPTY_METRICS: TextMetrics = { advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 }

function measureWithContext(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: FontDescriptor,
): TextMetrics {
  if (text === '') return EMPTY_METRICS
  ctx.font = fontCss(font)
  const metrics = ctx.measureText(text)
  const ascent = clampMetric(
    metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? font.sizePx * 0.8,
  )
  const descent = clampMetric(
    metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? font.sizePx * 0.2,
  )
  return { advanceWidth: clampMetric(metrics.width), ascent, descent, lineGap: 0 }
}

/**
 * Approximates advance width as a fixed ratio of font size per character.
 * Not visually accurate — only used when no real Canvas 2D context is
 * available (e.g. jsdom, which has no canvas backend by default) — but it
 * still satisfies MeasureText's contract: finite, non-negative, linear in
 * sizePx, empty string measures to 0.
 */
const FALLBACK_CHAR_WIDTH_RATIO = 0.6

function fallbackMeasure(text: string, font: FontDescriptor): TextMetrics {
  if (text === '') return EMPTY_METRICS
  return {
    advanceWidth: text.length * font.sizePx * FALLBACK_CHAR_WIDTH_RATIO,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: 0,
  }
}

/**
 * The browser half of canvas-render's injected MeasureText seam
 * (D3: canvas-render stays DOM-free, canvas-viewer supplies the browser
 * implementation). Lazily creates a single offscreen <canvas> 2D context
 * and reuses it across calls.
 */
export function createBrowserMeasureText(): MeasureText {
  let context: CanvasRenderingContext2D | null | undefined

  const getContext = (): CanvasRenderingContext2D | null => {
    if (context !== undefined) return context
    try {
      context = document.createElement('canvas').getContext('2d')
    } catch {
      context = null
    }
    return context
  }

  return (text: string, font: FontDescriptor): TextMetrics => {
    const ctx = getContext()
    return ctx ? measureWithContext(ctx, text, font) : fallbackMeasure(text, font)
  }
}
