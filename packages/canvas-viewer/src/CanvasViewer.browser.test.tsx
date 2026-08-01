// Real-browser lock for the SVG-viewer contract: jsdom has no real Canvas 2D
// backend, so it cannot prove the actual browser MeasureText implementation
// or a real mount produces a non-empty rendered <svg>. This is the nearest
// real-browser layer for both claims.

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'
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
})
