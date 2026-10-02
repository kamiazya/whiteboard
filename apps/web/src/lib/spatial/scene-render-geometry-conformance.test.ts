// @vitest-environment node
// Tier-2 conformance test for this surface (package-canvas-render.md
// decision #8 / the theme-layer slice): the editor must not diverge from
// canvas-render's own default geometry in EITHER theme mode. Asserts light
// and dark produce identical geometry and differ only in color — the
// executable form of the dark-mode-is-a-theme-parameter design decision.

import type { Scene } from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { renderCanvasToSvg } from './scene-render.js'

function fixture(): SpatialCanvas {
  return {
    nodes: [
      linkNode({ id: 'link-1', x: 0, y: 0, width: 120, height: 40, url: 'https://ex.com' }),
      textNode({ id: 'text-1', x: 200, y: 0, width: 10, height: 40, text: 'hi' }),
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
    const measure = createFakeMeasure(0.6)
    const canvas = fixture()
    const light = renderCanvasToSvg(canvas, { measure, theme: 'light' })
    const dark = renderCanvasToSvg(canvas, { measure, theme: 'dark' })

    expect(geometryOf(dark.scene)).toEqual(geometryOf(light.scene))
    expect(dark.svg).not.toBe(light.svg)
  })
})
