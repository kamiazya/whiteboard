// Smoke test for the actual measure-text/canvas-render/resvg pipeline.
// Other route tests mock the renderer to keep them fast; this file exists
// so a regression inside `headless-renderer.ts` itself surfaces in the unit
// test suite.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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

import { renderSceneToSvg } from '@kamiazya/whiteboard-canvas-render'
import { buildSpatialScene } from './headless-renderer.js'
import { createOpentypeMeasureText, loadExportFonts } from './measure-text.js'

describe('emphasis survives the whole export pipeline', () => {
  it('a real PNG render selects the vendored bold/italic faces — styled pixels differ from plain', async () => {
    const { renderSpatialCanvasToPng } = await importRenderer()
    const at = (text: string) => ({
      nodes: [{ id: 'n1', type: 'text' as const, x: 0, y: 0, width: 320, height: 120, text }],
      edges: [],
    })
    // Same painted words; only the emphasis differs. resvg must accept the
    // weight/style attributes AND paint different glyphs for them.
    const styled = await renderSpatialCanvasToPng(at('**bold** and *italic*'))
    const plain = await renderSpatialCanvasToPng(at('bold and italic'))
    expect(styled.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    expect(plain.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    expect(styled.png.equals(plain.png)).toBe(false)
  })

  it('markdown source with strong/emphasis reaches the SVG as weight/style attributes', async () => {
    const measure = await createOpentypeMeasureText()
    const scene = buildSpatialScene(
      {
        nodes: [
          {
            id: 'n1',
            type: 'text',
            x: 0,
            y: 0,
            width: 320,
            height: 200,
            text: 'plain **bold** *lean* ~~gone~~',
          },
        ],
        edges: [],
      },
      measure,
    )
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('font-weight="700"')
    expect(svg).toContain('font-style="italic"')
    expect(svg).toContain('text-decoration="line-through"')
  })
})

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
    expect(darkSvg.svg).toContain('fill="#0a0a0a"')
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

  it('theme="dark" renders real dark chrome: edge stroke, label fill, and a root text fill', async () => {
    // A diagram whose meaning lives in its arrows must survive a dark
    // export: light-theme edge chrome (#737373) on the dark background was
    // effectively invisible.
    const canvas = {
      nodes: [
        { id: 'a', type: 'text' as const, x: 0, y: 0, width: 120, height: 60, text: 'from' },
        { id: 'b', type: 'text' as const, x: 300, y: 0, width: 120, height: 60, text: 'to' },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'flows' }],
    }
    const { renderSpatialCanvasToSvg } = await importRenderer()
    const darkSvg = (await renderSpatialCanvasToSvg(canvas, { theme: 'dark' })).svg
    // Dark palette chrome (canvas-render SPATIAL_DARK_PALETTE).
    expect(darkSvg).toContain('stroke="#9BA3AF"')
    expect(darkSvg).toContain('fill="#E6E8EB"')
    expect(darkSvg).not.toContain('stroke="#737373"')
    // Root-level inheritable text fill so body runs are legible on dark.
    expect(darkSvg).toMatch(/<svg [^>]*fill="#E6E8EB">/)

    // The light export is byte-stable: no root fill, light chrome only.
    const lightSvg = (await renderSpatialCanvasToSvg(canvas, { theme: 'light' })).svg
    expect(lightSvg).toContain('stroke="#737373"')
    expect(lightSvg).not.toMatch(/<svg [^>]*fill=/)
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

  it('declares font-family="Roboto" on a label run, never "sans-serif"', async () => {
    // Regression guard for the verified export defect: `LABEL_APPEARANCE`
    // used to emit `fontFamily: 'sans-serif'` while the export measurer
    // (measure-text.ts) measured Roboto, so the SVG's coordinates were
    // computed from one font's metrics while its `font-family` attribute
    // named another. A `link` node's label run is the shape that exercises
    // `resolveLabel()` (a markdown body run carries no fontFamily at all —
    // a separate, documented gap).
    const { renderSpatialCanvasToSvg } = await importRenderer()
    const canvas: SpatialCanvas = {
      nodes: [
        {
          id: 'link-1',
          type: 'link',
          x: 0,
          y: 0,
          width: 200,
          height: 40,
          url: 'https://example.com',
        },
      ],
      edges: [],
    }
    const { svg } = await renderSpatialCanvasToSvg(canvas)
    expect(svg).toContain('font-family="Roboto"')
    expect(svg).not.toContain('sans-serif')
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
      // These mocks replace the module WHOLESALE, so every export
      // `headless-renderer` reaches for has to be answered here — an omission
      // is a runtime failure rather than a type error, and adding an export to
      // `measure-text.ts` has now broken this file twice. The empty/`null`
      // answers are the documented "no parsed face" case, which keeps these
      // tests about the singleton rather than about fonts.
      loadExportFont: vi.fn().mockResolvedValue(null),
      loadExportFonts: vi.fn().mockResolvedValue([]),
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
      // These mocks replace the module WHOLESALE, so every export
      // `headless-renderer` reaches for has to be answered here — an omission
      // is a runtime failure rather than a type error, and adding an export to
      // `measure-text.ts` has now broken this file twice. The empty/`null`
      // answers are the documented "no parsed face" case, which keeps these
      // tests about the singleton rather than about fonts.
      loadExportFont: vi.fn().mockResolvedValue(null),
      loadExportFonts: vi.fn().mockResolvedValue([]),
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
      // These mocks replace the module WHOLESALE, so every export
      // `headless-renderer` reaches for has to be answered here — an omission
      // is a runtime failure rather than a type error, and adding an export to
      // `measure-text.ts` has now broken this file twice. The empty/`null`
      // answers are the documented "no parsed face" case, which keeps these
      // tests about the singleton rather than about fonts.
      loadExportFont: vi.fn().mockResolvedValue(null),
      loadExportFonts: vi.fn().mockResolvedValue([]),
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
      resolveExportFontFaces: vi.fn(async () => ({
        regular: null,
        bold: null,
        italic: null,
        boldItalic: null,
      })),
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

describe('an export says which declared families it could not provide', () => {
  // The case that exists today, end to end: a fenced code block declares the
  // markdown theme's mono chain, and the export has the vendored Latin face
  // and nothing else. Every character is drawn — in the wrong face — so
  // `undrawable` is empty and only this answer says anything happened.
  const CODE_CANVAS: SpatialCanvas = {
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 320,
        height: 200,
        text: '```ts\nconst x = 1\n```',
      },
    ],
    edges: [],
  }

  it('reports the mono chain a fenced block declares, while undrawable stays empty', async () => {
    const { renderSpatialCanvasToSvg } = await importRenderer()
    const result = await renderSpatialCanvasToSvg(CODE_CANVAS, {})
    expect(result.undrawable).toEqual([])
    expect(result.unresolvedFamilies.join(' ')).toContain('ui-monospace')
  })

  it('says nothing for a canvas whose text declares only the export family', async () => {
    // Guards the vacuous pass: with no face loaded, `unresolvedFamilies`
    // answers `[]` for EVERY canvas by design, so this assertion would hold
    // while the report was inert. The mono case above is what proves the
    // machinery runs; this proves it can also stay quiet.
    expect((await loadExportFonts()).length).toBeGreaterThan(0)
    const { renderSpatialCanvasToSvg } = await importRenderer()
    const plain: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 320, height: 120, text: 'plain prose' }],
      edges: [],
    }
    expect((await renderSpatialCanvasToSvg(plain, {})).unresolvedFamilies).toEqual([])
  })
})
