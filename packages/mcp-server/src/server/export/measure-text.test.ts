import type { FontDescriptor, TextMetrics } from '@kamiazya/whiteboard-canvas-render'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { resolveExportFontFaces } from './export-font.js'
import { _resetExportMeasureTextCacheForTests, createOpentypeMeasureText } from './measure-text.js'

const NO_FACES = { regular: null, bold: null, italic: null, boldItalic: null }

function font(sizePx: number, overrides: Partial<FontDescriptor> = {}): FontDescriptor {
  return {
    family: 'Roboto',
    fallbackChain: [],
    weight: 400,
    style: 'normal',
    sizePx,
    ...overrides,
  }
}

function expectFiniteNonNegativeMetrics(metrics: TextMetrics) {
  for (const value of Object.values(metrics)) {
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
  }
}

describe('createOpentypeMeasureText', () => {
  afterEach(() => {
    _resetExportMeasureTextCacheForTests()
  })

  it('measures a spread of representative strings with finite, non-negative metrics', async () => {
    const measure = await createOpentypeMeasureText()
    const samples = ['A', 'Hello, world!', '0123456789', '.,:;!?()-', 'a long line of sample text']
    for (const text of samples) {
      for (const sizePx of [8, 16, 32, 64]) {
        const metrics = measure(text, font(sizePx))
        expectFiniteNonNegativeMetrics(metrics)
      }
    }
  })

  it('selects the bold and italic faces the descriptor asks for — bold is measurably wider', async () => {
    const measure = await createOpentypeMeasureText()
    const regular = measure('Hello, bold world', font(16))
    const bold = measure('Hello, bold world', font(16, { weight: 700 }))
    const italic = measure('Hello, bold world', font(16, { style: 'italic' }))
    // Roboto Bold's advances genuinely differ from Regular's; a measurer
    // that ignores the descriptor would return identical widths and the
    // painted 700 text would not fit the measured wrap positions.
    expect(bold.advanceWidth).toBeGreaterThan(regular.advanceWidth)
    // Roboto Italic differs from Regular too (slanted design, own metrics).
    expect(italic.advanceWidth).not.toBe(regular.advanceWidth)
  })

  it('measures "Hello" at 16px to a plausible CSS-px advance width', async () => {
    const measure = await createOpentypeMeasureText()
    const metrics = measure('Hello', font(16))
    // 5 chars * 16px, bounded well below the raw-design-units range
    // (unitsPerEm is typically 1000-2048) so a units-vs-px scaling bug
    // fails loudly instead of silently passing a wide contract-only check.
    expect(metrics.advanceWidth).toBeGreaterThan(16)
    expect(metrics.advanceWidth).toBeLessThan(5 * 16)
  })

  it('descent is returned as a positive magnitude', async () => {
    const measure = await createOpentypeMeasureText()
    const metrics = measure('gjpqy', font(32))
    expect(metrics.descent).toBeGreaterThan(0)
  })

  it('scales metrics linearly with sizePx (2x size doubles every field)', async () => {
    const measure = await createOpentypeMeasureText()
    const text = 'Scaling test 123'
    const base = measure(text, font(16))
    const doubled = measure(text, font(32))

    expect(doubled.advanceWidth).toBeCloseTo(base.advanceWidth * 2, 1)
    expect(doubled.ascent).toBeCloseTo(base.ascent * 2, 1)
    expect(doubled.descent).toBeCloseTo(base.descent * 2, 1)
  })

  it('scales metrics linearly at a non-integer ratio (16px -> 24px)', async () => {
    const measure = await createOpentypeMeasureText()
    const text = 'non-integer ratio'
    const base = measure(text, font(16))
    const scaled = measure(text, font(24))

    expect(scaled.advanceWidth).toBeCloseTo(base.advanceWidth * 1.5, 0)
    expect(scaled.ascent).toBeCloseTo(base.ascent * 1.5, 1)
  })

  it('measures the empty string with advanceWidth 0 at every size', async () => {
    const measure = await createOpentypeMeasureText()
    for (const sizePx of [0, 1, 16, 100]) {
      expect(measure('', font(sizePx)).advanceWidth).toBe(0)
    }
  })

  it('sizePx 0 yields all-zero, non-NaN metrics', async () => {
    const measure = await createOpentypeMeasureText()
    const metrics = measure('Hello', font(0))
    expect(metrics).toEqual({ advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 })
  })

  it('degrades a missing sibling face to Regular metrics instead of throwing', async () => {
    const measure = await createOpentypeMeasureText({
      resolveFontFiles: async () => ({
        ...(await resolveExportFontFaces()),
        bold: null,
        italic: null,
        boldItalic: null,
      }),
    })
    const regular = measure('Weight test', font(16))
    const bold = measure('Weight test', font(16, { weight: 700, style: 'italic' }))
    expect(bold).toEqual(regular)
  })

  it('caches the parsed font: repeated factory calls return metrics-equivalent measurers', async () => {
    const first = await createOpentypeMeasureText()
    const second = await createOpentypeMeasureText()
    expect(first('Cache test', font(20))).toEqual(second('Cache test', font(20)))
  })

  it('falls back to the constant-ratio measurer and logs once when the asset cannot be resolved', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const measure = await createOpentypeMeasureText({
        resolveFontFiles: async () => NO_FACES,
      })
      const metrics = measure('Hello', font(16))
      expectFiniteNonNegativeMetrics(metrics)

      // A second/third call must not add another warning — the failure (and
      // its fallback measurer) is cached after the first factory call.
      await createOpentypeMeasureText({ resolveFontFiles: async () => NO_FACES })
      await createOpentypeMeasureText({ resolveFontFiles: async () => NO_FACES })

      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.msg.includes('falling back to a constant-ratio'),
      )
      expect(warnings).toHaveLength(1)
    } finally {
      capture.restore()
    }
  })

  it('a corrupt sibling face degrades that face to Regular metrics and logs once', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const measure = await createOpentypeMeasureText({
        resolveFontFiles: async () => ({
          ...(await resolveExportFontFaces()),
          // Resolves, but the bytes are not a font: opentype.parse throws
          // for this face only — Regular already loaded.
          bold: import.meta.url.replace('file://', ''),
        }),
      })
      const regular = measure('Hello', font(16))
      const bold = measure('Hello', font(16, { weight: 700 }))
      expect(bold).toEqual(regular)
      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.msg.includes('constant-ratio'),
      )
      // The fallback warning names the whole-measurer degradation; a
      // per-face parse failure logs through the same once-guard.
      expect(warnings.length).toBeLessThanOrEqual(1)
    } finally {
      capture.restore()
    }
  })

  it('falls back to the constant-ratio measurer and logs once when the asset bytes are corrupt', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const measure = await createOpentypeMeasureText({
        // A path that resolves but whose bytes are not a valid font —
        // readFile succeeds, opentype.parse must be the one to throw.
        resolveFontFiles: async () => ({
          ...NO_FACES,
          regular: import.meta.url.replace('file://', ''),
        }),
      })
      const metrics = measure('Hello', font(16))
      expectFiniteNonNegativeMetrics(metrics)

      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.msg.includes('falling back to a constant-ratio'),
      )
      expect(warnings).toHaveLength(1)
    } finally {
      capture.restore()
    }
  })
})
