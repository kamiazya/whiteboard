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
import type {
  BoundingBox,
  NodeOutline,
  RenderContribution,
  ShapeContribution,
  ShapeTable,
} from '@kamiazya/whiteboard-scene'
import { isFiniteBox } from '../finite-box.js'

export type { NodeOutline, ShapeContribution, ShapeTable }

/**
 * A caller's table is MERGED OVER the built-ins, never a replacement — an id
 * it does not carry still resolves, and an id it does overrides. Done as a
 * fallback lookup rather than an object spread because this runs per node
 * per layout, and because it keeps the merge correct for a direct caller
 * (the SVG backend, a test) that never went through the layout entry point.
 */
const lookup = (shapes: ShapeTable, shapeId: string): ShapeContribution | undefined =>
  shapes[shapeId] ?? BUNDLED_SHAPE_TABLE[shapeId]

/**
 * The composed shape table a contribution set resolves to — what the SVG
 * backend must be handed alongside the scene.
 */
export function resolveShapeTable(contributions: readonly RenderContribution[]): ShapeTable {
  const table: Record<string, ShapeContribution> = {}
  for (const contribution of contributions) {
    for (const [name, shape] of Object.entries(contribution.shapes ?? {})) {
      table[`${contribution.namespace}.${name}`] = shape
    }
  }
  return table
}

/**
 * The bundled `visual` plugin's silhouettes, resolved the way any
 * contribution's are — the default a direct caller (hit-testing, a test)
 * gets, and the fallback a partial table is merged over.
 *
 * Resolved from the plugin rather than written out here, because this
 * module held a second copy of that table for as long as "until the plugin
 * owns them" lasted, and the copies drifted: `octagon` was drawn here and
 * declared by the plugin, which could not draw it on its own, and the
 * fallback below hid that. One producer per geometry, or a parity test —
 * this is the one producer.
 */
export const BUNDLED_SHAPE_TABLE: ShapeTable = resolveShapeTable([visualRenderContribution])

/**
 * An unknown id degrades to `null` — a plain rect — like any other malformed
 * input, because the VALUE arrives from a stored facet payload and a document
 * naming a shape this build does not carry is ordinary, not exceptional.
 */
export function nodeOutline(
  shapeId: string,
  box: BoundingBox,
  shapes: ShapeTable = BUNDLED_SHAPE_TABLE,
): NodeOutline | null {
  if (!isFiniteBox(box)) return null
  return lookup(shapes, shapeId)?.outline(box) ?? null
}
