// The single named constant block for spatial-scene composition
// (spatial-scene.ts). canvas-render's layout functions deliberately never
// invent a fill/stroke/font (see `Appearance` in canvas-render's
// scene-graph.ts) — that decision belongs to the composition root until the
// theme layer (Phase 4) lands. Every color/size literal used by this
// module's chrome and labels lives here, and only here, so the theme layer
// has one obvious place to replace.
import type { Appearance } from '@kamiazya/whiteboard-canvas-render'

/** Per spatial-node-kind chrome appearance (the box behind each node). */
export const SPATIAL_NODE_APPEARANCE: Readonly<
  Record<'text' | 'file' | 'link' | 'group', Appearance>
> = {
  text: { fill: '#ffffff', stroke: '#d0d0d0', strokeWidth: 1 },
  file: { fill: '#f5f5f5', stroke: '#c0c0c0', strokeWidth: 1 },
  link: { fill: '#eef4ff', stroke: '#a9c6ff', strokeWidth: 1 },
  // Groups are deliberately unfilled: a filled group rect emitted after (or
  // before) a member node in the flat, position-sorted node order would
  // otherwise risk painting over — or under — that member depending on
  // sort order. `fill: 'none'` removes the z-order question entirely.
  group: { fill: 'none', stroke: '#b0b0b0', strokeWidth: 1 },
} as const

/** Appearance applied to every routed edge. */
export const EDGE_APPEARANCE: Appearance = { stroke: '#606060', strokeWidth: 1.5 }

/** Appearance applied to the readable label run on `file`/`link`/`group` nodes. */
export const LABEL_APPEARANCE: Appearance = { fill: '#303030', fontFamily: 'sans-serif' }

/** Uniform padding (px) between a node's box edge and its laid-out content. */
export const NODE_PADDING_PX = 8

/** Uniform corner radius (px) applied to every node's chrome shape. */
export const NODE_CORNER_RADIUS_PX = 4

/** Font size (px) used for the `file`/`link`/`group` label run. */
export const LABEL_FONT_SIZE_PX = 14

/** Floor for a node's derived content width, so padding never drives it negative. */
export const MIN_CONTENT_WIDTH_PX = 1
