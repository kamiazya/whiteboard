// This package's `SpatialAppearanceResolver` (canvas-render's
// `layoutSpatialCanvas` appearance seam). Unlike mcp-server's export
// resolver (fixed per-node-kind chrome), the viewer derives fill from the
// node's own authored `color` (JSON Canvas presets) and radius from
// `x-whiteboard`'s ellipse shape hint, so the on-screen canvas reflects what
// the author actually set.
import type { CanvasColor, CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { Appearance, SpatialAppearanceResolver } from '@kamiazya/whiteboard-canvas-render'
import { VIEWER_FONT_FAMILY } from './font.js'

const CONTENT_PADDING_PX = 8
const CONTENT_FONT_SIZE_PX = 16

// JSON Canvas 1.0's six numbered color presets, approximated as hex so this
// package's Appearance (canvas-render's optional paint attributes) can carry
// a concrete fill without canvas-render ever having to know about presets.
const PRESET_COLOR_HEX: Readonly<Record<string, string>> = {
  '1': '#e03131',
  '2': '#e8590c',
  '3': '#f08c00',
  '4': '#2f9e44',
  '5': '#1971c2',
  '6': '#9c36b5',
}

function resolvePresetOrHex(color: CanvasColor | undefined): string | undefined {
  if (color === undefined) return undefined
  return color.startsWith('#') ? color : PRESET_COLOR_HEX[color]
}

// SVG's own default fill for an unstyled <rect> is solid black, and
// canvas-render's SVG backend never invents an appearance default. A
// colorless spatial node therefore needs an explicit transparent fill here,
// or every node without an authored `color` would render as an opaque black
// box. This default is shape-only: an edge with no authored color keeps
// `resolvePresetOrHex`'s `undefined` so it falls through to the SVG
// backend's own (visible, black) default line stroke.
const NO_FILL = 'none'

function resolveShapeFill(color: CanvasColor | undefined): string {
  return resolvePresetOrHex(color) ?? NO_FILL
}

function shapeRadius(node: SpatialNode): number | undefined {
  const extension = node['x-whiteboard']
  if (extension?.kind === 'shape' && extension.shape === 'ellipse') {
    return Math.min(node.width, node.height) / 2
  }
  return undefined
}

export const VIEWER_APPEARANCE: SpatialAppearanceResolver = {
  resolveNode: (node: SpatialNode) => {
    const radius = shapeRadius(node)
    const appearance: Appearance = { fill: resolveShapeFill(node.color) }
    return radius !== undefined ? { radius, appearance } : { appearance }
  },
  resolveEdge: (edge: CanvasEdge) => {
    const stroke = resolvePresetOrHex(edge.color)
    return stroke === undefined ? undefined : { stroke }
  },
  resolveLabel: () => ({ fontFamily: VIEWER_FONT_FAMILY }),
  paddingPx: CONTENT_PADDING_PX,
  labelFontSizePx: CONTENT_FONT_SIZE_PX,
  minContentWidthPx: 0,
}
