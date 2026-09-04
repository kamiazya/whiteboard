// Real-browser lock for the SVG-viewer contract: jsdom has no real Canvas 2D
// backend, so it cannot prove the actual browser MeasureText implementation
// or a real mount produces a non-empty rendered <svg>. This is the nearest
// real-browser layer for both claims.

import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'
import { VIEWER_FONT_FAMILY } from './font.js'
import { ensureViewerFontLoaded } from './font-loading.js'
import { createBrowserMeasureText } from './measure-text.js'

const goldenCanvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'Hello world' },
    { id: 'b', type: 'text', x: 200, y: 0, width: 120, height: 60, text: 'Second box' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

// Deterministic across Node and the browser: the SAME fake measurer used
// here must be the one a future node-project golden-determinism test uses,
// so the two produce byte-identical SVG (canvas-render already guarantees
// that for a fixed Scene — this pins the viewer's own scene-building stage
// adds no additional platform dependence).
const fakeMeasure: MeasureText = (text) => ({
  advanceWidth: text.length * 8,
  ascent: 12,
  descent: 4,
  lineGap: 0,
})

describe('CanvasViewer (real browser)', () => {
  it('mounts and renders a non-empty <svg> with the expected node/edge shapes', async () => {
    const { container } = render(<CanvasViewer canvas={goldenCanvas} measure={fakeMeasure} />)

    await expect.poll(() => container.querySelector('svg')).toBeTruthy()
    const svg = container.querySelector('svg')
    expect(svg?.querySelectorAll('rect').length).toBe(2)
    expect(svg?.querySelector('polyline')).toBeTruthy()
  })

  it('real Canvas 2D MeasureText satisfies the documented contract', () => {
    const measure = createBrowserMeasureText()
    const font = {
      family: 'Roboto',
      fallbackChain: ['sans-serif'],
      weight: 400,
      style: 'normal' as const,
      sizePx: 16,
    }

    expect(measure('', font).advanceWidth).toBe(0)

    const small = measure('whiteboard', { ...font, sizePx: 16 })
    const large = measure('whiteboard', { ...font, sizePx: 48 })
    for (const metrics of [small, large]) {
      for (const value of Object.values(metrics)) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
    // Linear scaling in sizePx within a generous relative tolerance — a real
    // font rasterizer's kerning/hinting means this is not exact, but a
    // design-units-vs-CSS-px bug would be off by a large, non-proportional
    // factor, which this still catches.
    expect(large.advanceWidth).toBeGreaterThan(small.advanceWidth * 2)
    expect(large.advanceWidth).toBeLessThan(small.advanceWidth * 4)

    const shorter = measure('a', font).advanceWidth
    const longer = measure('ab', font).advanceWidth
    expect(longer).toBeGreaterThanOrEqual(shorter)
  })

  it('measures VIEWER_FONT_FAMILY differently from a deliberately bogus family once loaded — this is the guard against silent Canvas 2D font fallback', async () => {
    const status = await ensureViewerFontLoaded()
    expect(status).toBe('loaded')

    const measure = createBrowserMeasureText()
    const sample = 'The quick brown fox jumps'
    const font = {
      fallbackChain: [],
      weight: 400,
      style: 'normal' as const,
      sizePx: 16,
    }

    const real = measure(sample, { ...font, family: VIEWER_FONT_FAMILY })
    const bogus = measure(sample, { ...font, family: 'ThisFontDoesNotExist12345' })

    expect(real.advanceWidth).not.toBe(bogus.advanceWidth)
  })

  it('re-measures with the real font once readiness ticks for a component mounted before it was ready', async () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 60, text: 'Whiteboard' }],
      edges: [],
    }

    const { container, unmount } = render(<CanvasViewer canvas={canvas} />)

    // useViewerFontReady's effect kicks off (or joins) the shared load; wait
    // for the component to observe readiness and re-render.
    await expect.poll(() => container.querySelector('svg')).toBeTruthy()
    await ensureViewerFontLoaded()

    unmount()
  })
})

/**
 * The half the DOM cannot state: a viewer given no size FITS its container.
 *
 * The framing fix (a viewBox, pinned in CanvasViewer.test.tsx) is necessary
 * and not sufficient — an SVG sized only by its own content still renders at
 * that content's pixel size, so a canvas larger than the pane is cut off and
 * one smaller sits in a corner. Fitting needs the container's real measured
 * box, which is a layout fact and exists in no other layer.
 */
describe('CanvasViewer fits the box it is given', () => {
  const farCanvas: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 400, y: 300, width: 200, height: 80, text: 'far from origin' },
      { id: 'b', type: 'text', x: 900, y: 700, width: 200, height: 80, text: 'also far' },
    ],
    edges: [],
  }

  it('draws the whole canvas inside the pane, not off its edge', async () => {
    const { container } = render(
      <div style={{ width: '400px', height: '300px' }}>
        <CanvasViewer canvas={farCanvas} measure={fakeMeasure} />
      </div>,
    )
    const pane = container.firstElementChild as HTMLElement

    // The SVG takes the pane's box rather than the content's own pixel size.
    await expect
      .poll(() => container.querySelector('svg')?.getBoundingClientRect().width ?? 0)
      .toBeCloseTo(400, 0)
    const svg = container.querySelector('svg') as SVGSVGElement
    expect(svg.getBoundingClientRect().height).toBeCloseTo(300, 0)

    // And every drawn node lands inside that box. Before the fix the same
    // canvas put both rects entirely outside it.
    const paneBox = pane.getBoundingClientRect()
    const rects = [...svg.querySelectorAll('rect')]
    expect(rects.length).toBe(2)
    for (const rect of rects) {
      const box = rect.getBoundingClientRect()
      expect(box.width).toBeGreaterThan(0)
      expect(box.left).toBeGreaterThanOrEqual(paneBox.left - 1)
      expect(box.right).toBeLessThanOrEqual(paneBox.right + 1)
      expect(box.top).toBeGreaterThanOrEqual(paneBox.top - 1)
      expect(box.bottom).toBeLessThanOrEqual(paneBox.bottom + 1)
    }
  })
})
