// Tier-2 conformance test for this surface (package-canvas-render.md
// decision #8 / the theme-layer slice): the editor must not diverge from
// canvas-render's own default geometry in EITHER theme mode. Asserts light
// and dark produce identical geometry and differ only in color — the
// executable form of the dark-mode-is-a-theme-parameter design decision.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText, Scene } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { renderCanvasToSvg } from './scene-render.js'

function fakeMeasure(): MeasureText {
  return (text, font) => ({
    advanceWidth: text.length * 0.6 * font.sizePx,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: font.sizePx * 0.1,
  })
}

function fixture(): SpatialCanvas {
  return {
    nodes: [
      { id: 'link-1', type: 'link', x: 0, y: 0, width: 120, height: 40, url: 'https://ex.com' },
      { id: 'text-1', type: 'text', x: 200, y: 0, width: 10, height: 40, text: 'hi' },
    ],
    edges: [],
  }
}

function geometryOf(scene: Scene): unknown {
  // `ResolvedEdgeNode` carries `path`, not `bbox` — every other SceneNode
  // variant carries `bbox`. This is a geometry-only projection (no
  // color/stroke/fontFamily), matching canvas-render's own
  // `spatial-geometry-parity.test.ts`.
  return scene.nodes.map((node) =>
    node.kind === 'edge'
      ? { kind: node.kind, path: node.path }
      : { kind: node.kind, bbox: node.bbox },
  )
}

describe('spatial editor geometry conformance', () => {
  it('produces identical geometry for light and dark, differing only in color', () => {
    const measure = fakeMeasure()
    const canvas = fixture()
    const light = renderCanvasToSvg(canvas, { measure, theme: 'light' })
    const dark = renderCanvasToSvg(canvas, { measure, theme: 'dark' })

    expect(geometryOf(dark.scene)).toEqual(geometryOf(light.scene))
    expect(dark.svg).not.toBe(light.svg)
  })
})
