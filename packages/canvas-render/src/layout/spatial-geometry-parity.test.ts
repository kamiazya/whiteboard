// The headline guard for the theme-layer slice (package-canvas-render.md
// decision #8): the SAME `SpatialCanvas` laid out through divergently
// colored appearance resolvers must agree on GEOMETRY (every bbox
// recursively, every textRun baseline, every edge path point) even though
// they may legitimately disagree on color/stroke/fontFamily. This is the
// property the pre-theme three-resolver split violated via
// `minContentWidthPx`/`labelFontSizePx`.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect, it } from 'vitest'
import type { Scene, SceneNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const measure = createFakeMeasure()

function fakeParseBody(text: string): MdastRoot {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
}

// Three appearance-only resolvers that disagree on nothing but color — the
// narrowed `SpatialAppearanceResolver` (post-theme-layer) has no room left
// for a resolver to smuggle in its own geometry.
const editorShaped: SpatialAppearanceResolver = {
  resolveNode: () => ({ appearance: { fill: 'none', stroke: '#333333' } }),
  resolveEdge: () => ({ stroke: '#333333' }),
  resolveLabel: () => ({ fill: '#333333' }),
}

const viewerShaped: SpatialAppearanceResolver = {
  resolveNode: () => ({ appearance: { fill: '#e03131' } }),
  resolveEdge: () => ({ stroke: '#e03131' }),
  resolveLabel: () => ({ fill: '#000000' }),
}

const exportShaped: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4, appearance: { fill: '#ffffff', stroke: '#d0d0d0' } }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
}

/** A fixture exercising every divergence-triggering shape from the spec. */
function fixture(): SpatialCanvas {
  const nodes: SpatialNode[] = [
    // (a) a labeled `link` node — drives labelFontSizePx via labelRun.
    {
      id: 'link-1',
      type: 'link',
      x: 0,
      y: 0,
      width: 120,
      height: 40,
      url: 'https://example.com',
    },
    // (b) a node narrower than ~17px — drives minContentWidthPx, otherwise
    // invisible since a wider node never hits the floor.
    {
      id: 'text-narrow',
      type: 'text',
      x: 200,
      y: 0,
      width: 10,
      height: 40,
      text: 'hi there world, this wraps',
    },
    // (d) a multi-line wrapping body — proves wrapped-line counts agree.
    {
      id: 'text-wide',
      type: 'text',
      x: 400,
      y: 0,
      width: 120,
      height: 80,
      text: 'a fairly long line of text that should wrap across more than one line',
    },
  ]
  const edges: SpatialCanvas['edges'] = [
    // (c) an edge carrying a label — drives labelFontSizePx via composeEdgeLabel.
    { id: 'edge-1', fromNode: 'link-1', toNode: 'text-wide', label: 'connects to' },
  ]
  return { nodes, edges }
}

function layout(appearance: SpatialAppearanceResolver): Scene {
  return layoutSpatialCanvas(fixture(), { measure, parseBody: fakeParseBody, appearance })
}

/** Strips appearance/radius, keeping only bbox/baseline/path geometry, recursively. */
function geometryOnly(node: SceneNode): unknown {
  switch (node.kind) {
    case 'textRun':
      return { kind: node.kind, bbox: node.bbox, baseline: node.baseline, text: node.text }
    case 'edge':
      return { kind: node.kind, path: node.path }
    default:
      return { kind: node.kind, bbox: node.bbox }
  }
}

function sceneGeometry(scene: Scene): unknown {
  return scene.nodes.map(geometryOnly)
}

describe('spatial geometry parity across divergent appearance resolvers', () => {
  it('agrees on geometry regardless of which resolver supplied appearance', () => {
    const editorGeometry = sceneGeometry(layout(editorShaped))
    const viewerGeometry = sceneGeometry(layout(viewerShaped))
    const exportGeometry = sceneGeometry(layout(exportShaped))

    expect(viewerGeometry).toEqual(editorGeometry)
    expect(exportGeometry).toEqual(editorGeometry)
  })
})
