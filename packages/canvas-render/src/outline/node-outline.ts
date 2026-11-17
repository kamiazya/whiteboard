/**
 * The ONE producer of non-rect node silhouettes, per this package's "one
 * producer per geometry, or a parity test" rule: the SVG backend draws the
 * outline this module decomposes. The core hit-tests and anchors edges
 * against its port of the same silhouettes, held to the recording in
 * `oracle/node-outline.jsonl`.
 *
 * Outlines derive from the node's bbox and a KIND — never stored path
 * coordinates — so `translateScene` needs no knowledge of them (the bbox
 * moves, the outline follows) and `scaleScene` scales them implicitly.
 * Everything here is pure and total: a bbox with a non-finite field yields
 * `null` instead of throwing, per the package's never-throw rule.
 */

import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { BoundingBox, NodeOutline, ShapeTable } from '@kamiazya/whiteboard-scene'
import { isFiniteBox } from '../finite-box.js'

export type { NodeOutline }

/**
 * The bundled `visual` plugin's silhouettes by namespaced id, the only table
 * there is: the Rust core lays out against its port of the same silhouettes,
 * so a table of a caller's own would draw an outline the core never anchored
 * an edge to or contained content in.
 *
 * Resolved from the plugin rather than written out here, because this
 * module held a second copy of that table for as long as "until the plugin
 * owns them" lasted, and the copies drifted: `octagon` was drawn here and
 * declared by the plugin, which could not draw it on its own, and the
 * fallback below hid that. One producer per geometry, or a parity test —
 * this is the one producer.
 */
export const BUNDLED_SHAPE_TABLE: ShapeTable = Object.fromEntries(
  Object.entries(visualRenderContribution.shapes ?? {}).map(([name, shape]) => [
    `${visualRenderContribution.namespace}.${name}`,
    shape,
  ]),
)

/**
 * An unknown id degrades to `null` — a plain rect — like any other malformed
 * input, because the VALUE arrives from a stored facet payload and a document
 * naming a shape this build does not carry is ordinary, not exceptional.
 */
export function nodeOutline(shapeId: string, box: BoundingBox): NodeOutline | null {
  if (!isFiniteBox(box)) return null
  return BUNDLED_SHAPE_TABLE[shapeId]?.outline(box) ?? null
}
