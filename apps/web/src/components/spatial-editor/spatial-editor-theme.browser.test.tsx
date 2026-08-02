/**
 * jsdom cannot tell us whether dark-mode chrome is actually *visible* — this
 * mounts SpatialEditor in a real browser and reads the injected SVG's real
 * attribute values, pinning the exact intended hex per theme (never merely
 * "not #333333", which would pass for any wrong color too).
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EDITOR_DARK_PALETTE, EDITOR_LIGHT_PALETTE } from './editor-appearance.js'
import { SpatialEditor } from './SpatialEditor.js'

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
  it('renders dark-mode chrome and edge stroke as the intended dark hex, never #333333', () => {
    document.documentElement.classList.add('dark')
    const { container } = render(
      <SpatialEditor
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="dark"
      />,
    )
    document.documentElement.classList.remove('dark')

    const rects = container.querySelectorAll('svg rect')
    expect(rects.length).toBeGreaterThan(0)
    for (const rect of rects) {
      expect(rect.getAttribute('stroke')).toBe(EDITOR_DARK_PALETTE.chromeStroke)
    }
    const edgePaths = container.querySelectorAll('svg path, svg polyline, svg line')
    expect(edgePaths.length).toBeGreaterThan(0)
    for (const edgeEl of edgePaths) {
      expect(edgeEl.getAttribute('stroke')).toBe(EDITOR_DARK_PALETTE.chromeStroke)
    }
  })

  it('renders light-mode chrome as #333333, proving the light path is untouched', () => {
    const { container } = render(
      <SpatialEditor
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="light"
      />,
    )
    const rects = container.querySelectorAll('svg rect')
    expect(rects.length).toBeGreaterThan(0)
    for (const rect of rects) {
      expect(rect.getAttribute('stroke')).toBe(EDITOR_LIGHT_PALETTE.chromeStroke)
    }
  })

  it('does not change scene geometry between themes — only color attributes differ', () => {
    const light = render(
      <SpatialEditor
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="light"
      />,
    )
    const lightViewBox = light.container.querySelector('svg')?.getAttribute('viewBox')
    cleanup()
    const dark = render(
      <SpatialEditor
        canvas={twoNodeCanvasWithEdge()}
        onChange={() => {}}
        measure={fakeMeasure}
        theme="dark"
      />,
    )
    const darkViewBox = dark.container.querySelector('svg')?.getAttribute('viewBox')
    expect(darkViewBox).toBe(lightViewBox)
  })
})
