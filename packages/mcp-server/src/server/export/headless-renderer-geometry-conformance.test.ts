// Tier-2 conformance test for this surface (package-canvas-render.md
// decision #8 / the theme-layer slice): export must not diverge from
// canvas-render's own default geometry. Uses `buildSpatialScene` (the
// exported seam in headless-renderer.ts) with an injected fake measurer, so
// this stays a fast unit test with no real opentype.js font load — the
// mutation-check target for this slice.

import type { MeasureText, Scene } from '@kamiazya/whiteboard-canvas-render'
import { createSpatialTheme, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { buildSpatialScene } from './headless-renderer.js'

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

// Geometry-only projection (no color/stroke/fontFamily). `ResolvedEdgeNode`
// carries `path`, every other SceneNode variant carries `bbox` — same shape
// canvas-render's own `spatial-geometry-parity.test.ts` compares.
function geometryOf(scene: Scene): unknown {
  return scene.nodes.map((node) =>
    node.kind === 'edge'
      ? { kind: node.kind, path: node.path }
      : { kind: node.kind, bbox: node.bbox },
  )
}

describe('mcp-server export geometry conformance', () => {
  it('produces the same geometry as layoutSpatialCanvas with no geometry override', () => {
    const measure = fakeMeasure()
    const canvas = fixture()

    const exportScene = buildSpatialScene(canvas, measure)
    const defaultScene = layoutSpatialCanvas(canvas, {
      measure,
      parseBody: parseMarkdownBody,
      appearance: createSpatialTheme({ mode: 'light' }),
    })

    expect(geometryOf(exportScene)).toEqual(geometryOf(defaultScene))
  })
})
