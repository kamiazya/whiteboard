/**
 * jsdom cannot tell us whether dark-mode chrome is actually *visible* — this
 * mounts SpatialEditor in a real browser and reads the injected SVG's real
 * attribute values, pinning the exact intended hex per theme (never merely
 * "not #737373", which would pass for any wrong color too).
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EDITOR_DARK_PALETTE, EDITOR_LIGHT_PALETTE } from './editor-appearance.js'
import { SpatialEditor } from './SpatialEditor.js'

/** A real browser normalizes an inline `fill: '#RRGGBB'` style to `rgb(r, g, b)`. */
function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgb(${r}, ${g}, ${b})`
}

function fakeMeasure() {
  return { advanceWidth: 30, ascent: 10, descent: 2, lineGap: 0 }
}

function twoNodeCanvasWithEdge(): SpatialCanvas {
  return {
    nodes: [
      { id: 'a', type: 'text', x: 20, y: 20, width: 100, height: 60, text: 'hello' },
      { id: 'b', type: 'text', x: 250, y: 20, width: 100, height: 60, text: 'world' },
    ],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
  }
}

afterEach(() => {
  cleanup()
})

describe('SpatialEditor theme chrome (real browser)', () => {
  it('renders dark-mode chrome and edge stroke as the intended dark hex, never #737373', () => {
    document.documentElement.classList.add('dark')
    const { container } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="dark"
      />,
    )
    document.documentElement.classList.remove('dark')

    const rects = container.querySelectorAll('[data-testid="viewport-transform"] svg rect')
    expect(rects.length).toBeGreaterThan(0)
    for (const rect of rects) {
      expect(rect.getAttribute('stroke')).toBe(EDITOR_DARK_PALETTE.chromeStroke)
    }
    const edgePaths = container.querySelectorAll(
      '[data-testid="viewport-transform"] :is(svg path, svg polyline, svg line)',
    )
    expect(edgePaths.length).toBeGreaterThan(0)
    for (const edgeEl of edgePaths) {
      expect(edgeEl.getAttribute('stroke')).toBe(EDITOR_DARK_PALETTE.chromeStroke)
    }
  })

  it('renders light-mode chrome with the light palette stroke (#737373)', () => {
    const { container } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="light"
      />,
    )
    const rects = container.querySelectorAll('[data-testid="viewport-transform"] svg rect')
    expect(rects.length).toBeGreaterThan(0)
    for (const rect of rects) {
      expect(rect.getAttribute('stroke')).toBe(EDITOR_LIGHT_PALETTE.chromeStroke)
    }
  })

  it('sets the host element fill to the theme text color, the seam markdown body runs inherit', () => {
    const { container } = render(
      <SpatialEditor
        defaultTool="select"
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="dark"
      />,
    )
    const svg = container.querySelector('[data-testid="viewport-transform"] svg')
    const host = svg?.parentElement
    expect(host?.style.fill).toBe(hexToRgb(EDITOR_DARK_PALETTE.textFill))
  })

  it('does not change scene geometry between themes — only color attributes differ', () => {
    const light = render(
      <SpatialEditor
        defaultTool="select"
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="light"
      />,
    )
    const lightViewBox = light.container
      .querySelector('[data-testid="viewport-transform"] svg')
      ?.getAttribute('viewBox')
    cleanup()
    const dark = render(
      <SpatialEditor
        defaultTool="select"
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="dark"
      />,
    )
    const darkViewBox = dark.container
      .querySelector('[data-testid="viewport-transform"] svg')
      ?.getAttribute('viewBox')
    expect(darkViewBox).toBe(lightViewBox)
  })
})
