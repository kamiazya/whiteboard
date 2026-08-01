// Smoke test for the actual measure-text/canvas-render/resvg pipeline.
// Other route tests mock the renderer to keep them fast; this file exists
// so a regression inside `headless-renderer.ts` itself surfaces in the unit
// test suite.

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Resolved AFTER vi.resetModules(), never statically imported at the top of
// this file: `resetModules()` makes every subsequent `import('./x.js')`
// resolve a fresh module instance, so a reset helper bound before the reset
// would clear the PREVIOUS instance's cache while the code under test (via
// `importRenderer()`, itself resolved post-reset) reads from a new one.
async function resetMeasureTextCache(): Promise<void> {
  const { _resetExportMeasureTextCacheForTests } = await import('./measure-text.js')
  _resetExportMeasureTextCacheForTests()
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function rectCanvas(over: Partial<SpatialCanvas['nodes'][number]> = {}): SpatialCanvas {
  return {
    nodes: [
      {
        id: 'rect-1',
        type: 'text',
        x: 50,
        y: 50,
        width: 200,
        height: 100,
        text: 'hello world',
        ...over,
      },
    ],
    edges: [],
  }
}

async function importRenderer() {
  return import('./headless-renderer.js')
}

describe('headless-renderer', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetMeasureTextCache()
  })

  it('renders a rectangle canvas to a real PNG with the expected magic header', async () => {
    const { renderSpatialCanvasToPng } = await importRenderer()
    const result = await renderSpatialCanvasToPng(rectCanvas())
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    // Real PNG output, not just a stub buffer.
    expect(result.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    expect(result.png.length).toBeGreaterThan(200)
    expect(result.png.length).toBeLessThan(1_000_000)
  })

  it('renders an empty canvas to a valid, non-degenerate PNG', async () => {
    const { renderSpatialCanvasToPng } = await importRenderer()
    const result = await renderSpatialCanvasToPng({ nodes: [], edges: [] })
    expect(result.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('renders a dark canvas background when theme="dark"', async () => {
    const { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } = await importRenderer()
    const canvas = rectCanvas()
    const light = await renderSpatialCanvasToPng(canvas, { theme: 'light' })
    const dark = await renderSpatialCanvasToPng(canvas, { theme: 'dark' })
    // Same canvas rendered with two themes must not produce byte-identical PNGs.
    expect(dark.png.equals(light.png)).toBe(false)

    // The background reaches the SVG as a leading background rect — assert
    // the fill color directly rather than decoding rendered PNG pixels.
    const lightSvg = await renderSpatialCanvasToSvg(canvas, { theme: 'light' })
    const darkSvg = await renderSpatialCanvasToSvg(canvas, { theme: 'dark' })
    expect(lightSvg.svg).toContain('fill="#ffffff"')
    expect(darkSvg.svg).toContain('fill="#121212"')
  })

  it('produces PNG dimensions proportional to scale', async () => {
    const { renderSpatialCanvasToPng } = await importRenderer()
    const canvas = rectCanvas()
    const base = await renderSpatialCanvasToPng(canvas, { scale: 1 })
    for (const scale of [2, 3]) {
      const scaled = await renderSpatialCanvasToPng(canvas, { scale })
      expect(Math.abs(scaled.width - Math.round(base.width * scale))).toBeLessThanOrEqual(1)
      expect(Math.abs(scaled.height - Math.round(base.height * scale))).toBeLessThanOrEqual(1)
    }
  })

  it('degrades a degenerate scale to an unscaled render instead of throwing', async () => {
    const { renderSpatialCanvasToPng } = await importRenderer()
    const canvas = rectCanvas()
    const base = await renderSpatialCanvasToPng(canvas, { scale: 1 })
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const degenerate = await renderSpatialCanvasToPng(canvas, { scale })
      expect(degenerate.width).toBe(base.width)
      expect(degenerate.height).toBe(base.height)
    }
  })

  it('renders a canvas to real SVG markup with the document envelope', async () => {
    const { renderSpatialCanvasToSvg } = await importRenderer()
    const result = await renderSpatialCanvasToSvg(rectCanvas())
    expect(result.svg.trim().startsWith('<svg')).toBe(true)
    expect(result.svg).toContain('</svg>')
    expect(result.svg).toMatch(/width="[\d.]+"/)
    expect(result.svg).toMatch(/height="[\d.]+"/)
    expect(result.svg).toMatch(/viewBox="[^"]+"/)
  })

  it('renders the same canvas to byte-identical SVG twice, in-process and after a singleton reset', async () => {
    const { renderSpatialCanvasToSvg } = await importRenderer()
    const canvas = rectCanvas()
    const first = await renderSpatialCanvasToSvg(canvas)
    const second = await renderSpatialCanvasToSvg(canvas)
    expect(second.svg).toBe(first.svg)

    vi.resetModules()
    await resetMeasureTextCache()
    const { renderSpatialCanvasToSvg: renderAfterReset } = await importRenderer()
    const third = await renderAfterReset(canvas)
    expect(third.svg).toBe(first.svg)
  })

  it('increasing padding does not shrink the resulting viewBox', async () => {
    const { renderSpatialCanvasToSvg } = await importRenderer()
    const canvas = rectCanvas()
    const small = await renderSpatialCanvasToSvg(canvas, { padding: 0 })
    const large = await renderSpatialCanvasToSvg(canvas, { padding: 50 })
    const extractViewBox = (svg: string) => {
      const match = svg.match(/viewBox="([^"]+)"/)
      if (!match) throw new Error('expected a viewBox attribute')
      const [, , w, h] = match[1].split(' ').map(Number)
      return { w, h }
    }
    const smallBox = extractViewBox(small.svg)
    const largeBox = extractViewBox(large.svg)
    expect(largeBox.w).toBeGreaterThanOrEqual(smallBox.w)
    expect(largeBox.h).toBeGreaterThanOrEqual(smallBox.h)
  })

  it('shares one underlying build across concurrent first calls', async () => {
    // Spy on the build seam (the font measurer factory) to prove the
    // singleton's in-flight promise is shared, not raced: N concurrent
    // first callers must invoke it exactly once, not N times.
    const buildSpy = vi.fn(async () => () => ({
      advanceWidth: 0,
      ascent: 0,
      descent: 0,
      lineGap: 0,
    }))
    vi.doMock('./measure-text.js', () => ({
      createOpentypeMeasureText: buildSpy,
      _resetExportMeasureTextCacheForTests: vi.fn(),
    }))
    try {
      const { renderSpatialCanvasToSvg } = await importRenderer()
      const canvas = rectCanvas()
      const [a, b, c] = await Promise.all([
        renderSpatialCanvasToSvg(canvas),
        renderSpatialCanvasToSvg(canvas),
        renderSpatialCanvasToSvg(canvas),
      ])
      expect(a.svg).toBe(b.svg)
      expect(b.svg).toBe(c.svg)
      expect(buildSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('./measure-text.js')
    }
  })

  it('rebuilds after a failed first build instead of permanently replaying the rejection', async () => {
    vi.doMock('./measure-text.js', () => ({
      createOpentypeMeasureText: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(() => ({ advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 })),
      _resetExportMeasureTextCacheForTests: vi.fn(),
    }))
    const { renderSpatialCanvasToSvg } = await importRenderer()
    await expect(renderSpatialCanvasToSvg(rectCanvas())).rejects.toThrow('boom')
    // A second call retries the build from scratch rather than replaying
    // the same rejected promise forever.
    await expect(renderSpatialCanvasToSvg(rectCanvas())).resolves.toBeDefined()
    vi.doUnmock('./measure-text.js')
  })

  it('prewarmHeadlessExporter never rejects, even when the underlying build throws', async () => {
    vi.doMock('./measure-text.js', () => ({
      createOpentypeMeasureText: vi.fn().mockRejectedValue(new Error('font load failed')),
      _resetExportMeasureTextCacheForTests: vi.fn(),
    }))
    // `captureLogsForTests` must come from the SAME fresh module instance
    // `headless-renderer.js` resolves its own `getLogger` through — both
    // imported after `vi.resetModules()` — otherwise the capture attaches
    // to a stale `log.js` instance's destination set and never observes
    // the fresh instance's writes.
    const { captureLogsForTests } = await import('../log.js')
    const capture = captureLogsForTests('debug')
    try {
      const { prewarmHeadlessExporter } = await importRenderer()
      await expect(prewarmHeadlessExporter()).resolves.toBeUndefined()
      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.msg.includes('pre-warm failed'),
      )
      expect(warnings).toHaveLength(1)
    } finally {
      capture.restore()
      vi.doUnmock('./measure-text.js')
    }
  })

  it('degrades to system fonts with a single warning when the font asset is missing', async () => {
    vi.doMock('./export-font.js', () => ({
      EXPORT_FONT_FAMILY: 'Roboto',
      resolveExportFontFile: vi.fn(async () => null),
    }))
    const { captureLogsForTests } = await import('../log.js')
    const capture = captureLogsForTests('debug')
    try {
      const { renderSpatialCanvasToPng } = await importRenderer()
      const result = await renderSpatialCanvasToPng(rectCanvas())
      expect(result.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
      const fontWarnings = capture.records.filter((r) => r.msg.includes('Roboto TTF not found'))
      expect(fontWarnings).toHaveLength(1)
    } finally {
      capture.restore()
      vi.doUnmock('./export-font.js')
    }
  })

  afterEach(() => {
    vi.doUnmock('./measure-text.js')
    vi.doUnmock('./export-font.js')
  })
})
