import type { CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { VISUAL_STROKE_KEY } from '@kamiazya/whiteboard-plugin-visual'
import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from '../../svg/backend.js'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from '../../theme/spatial-appearance.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from '../spatial-canvas.js'

function options(resolveEdge: SpatialAppearanceResolver['resolveEdge']): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: { resolveNode: () => ({}), resolveEdge, resolveLabel: () => ({}) },
    geometry: { paddingPx: 8, labelFontSizePx: 14, minContentWidthPx: 1 },
  }
}

function stroke(width?: 'medium' | 'thick'): CanvasLine {
  return {
    id: 'ink',
    from: { kind: 'point', point: { x: 0, y: 0 }, end: 'none' },
    to: { kind: 'point', point: { x: 200, y: 80 }, end: 'none' },
    bends: [{ x: 100, y: 10 }],
    facets: {
      'visual.edges/v0': { routing: 'curved' },
      ...(width === undefined ? {} : { [VISUAL_STROKE_KEY]: { width } }),
    },
  }
}

function inkOf(line: CanvasLine, resolveEdge: SpatialAppearanceResolver['resolveEdge']) {
  const canvas: SpatialCanvas = { nodes: [], edges: [], lines: [line] }
  const scene = layoutSpatialCanvas(canvas, options(resolveEdge))
  const ink = scene.nodes.find((n): n is ResolvedEdgeNode => n.kind === 'edge' && n.id === 'ink')
  return { ink, svg: renderSceneToSvg(scene) }
}

describe('a stroke drawn at a chosen weight', () => {
  it('scales the theme line weight by the weight the stroke carries', () => {
    const themed = () => ({ stroke: '#606060', strokeWidth: 2 })
    expect(inkOf(stroke(), themed).ink?.appearance?.strokeWidth).toBe(2)
    expect(inkOf(stroke('medium'), themed).ink?.appearance?.strokeWidth).toBe(5)
    expect(inkOf(stroke('thick'), themed).ink?.appearance?.strokeWidth).toBe(10)
  })

  it('weighs against the SVG default of 1 when the theme names no weight', () => {
    // The bundled look sets no stroke-width on an edge at all, so SVG's
    // initial value is the thin a stroke has always been drawn at.
    const bare = () => ({ stroke: '#606060' })
    expect(inkOf(stroke(), bare).ink?.appearance).toEqual({ stroke: '#606060' })
    expect(inkOf(stroke('thick'), bare).svg).toContain('stroke-width="5"')
  })
})
