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
import type { MeasureText } from '../measure.js'
import type { Scene, SceneNode } from '../scene-graph.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

// Deliberately NOT the shared `createFakeMeasure`, which ignores
// `font.family` — with a family-blind measurer this whole file passes for any
// resolver whatsoever, because a resolver's remaining influence on geometry
// runs exclusively through the family it declares (`resolveLabel().fontFamily`
// reaches `measure`, see spatial-canvas.ts). The real measurers are
// family-sensitive (browser Canvas 2D, opentype.js), so a family-blind fake
// hides the one divergence this guard still has to catch.
const CHAR_WIDTH_BY_FAMILY: Readonly<Record<string, number>> = {
  'sans-serif': 0.6,
  Roboto: 0.55,
}

const measure: MeasureText = (text, font) => {
  const charWidth = CHAR_WIDTH_BY_FAMILY[font.family] ?? 0.6
  return {
    advanceWidth: text.length * charWidth * font.sizePx,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: font.sizePx * 0.1,
  }
}

function fakeParseBody(text: string): MdastRoot {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
}

// Three appearance-only resolvers that disagree on nothing but color. The
// narrowed `SpatialAppearanceResolver` (post-theme-layer) has no room left for
// a resolver to carry its own geometry CONSTANTS, so those cannot diverge by
// construction. What a resolver can still change is the label FAMILY, and
// family changes text metrics — which is why all three declare the same one
// (explicitly, or via layout's 'sans-serif' fallback) and why the measurer
// above is family-sensitive.
const editorShaped: SpatialAppearanceResolver = {
  resolveNode: () => ({ appearance: { fill: 'none', stroke: '#737373' } }),
  resolveEdge: () => ({ stroke: '#737373' }),
  resolveLabel: () => ({ fill: '#737373' }),
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
