/**
 * A document's shape, as rectangles in its own coordinates.
 *
 * One concept behind three surfaces — the favicon, a tree row's icon, and a
 * list card — because at the size any of them get, a faithful render is
 * unreadable anyway: what carries is the arrangement. Reducing both document
 * kinds to the same thing is what lets those surfaces share a projection
 * (`projectRectsToBoard`) instead of growing a renderer each.
 *
 * The two kinds differ only in where the rectangles come from. A spatial
 * canvas already IS boxes. A markdown document has none of its own, so its
 * shape is the shape its blocks take once laid out — which is why the
 * markdown side needs a real layout pass and the spatial side does not.
 */

import type { Scene, SceneNode } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { FaviconRect } from './favicon.js'
import { resolveRectColor } from './favicon.js'

/**
 * What a document's outline is computed FROM, paired with the id of the
 * state it is.
 *
 * One value rather than two reads, because the pairing is the whole
 * correctness of the memo above it: bytes from after an edit filed under the
 * version from before it would serve the previous picture for as long as
 * that version stands. The producer reads both in one synchronous block —
 * nothing can commit between two synchronous reads — and hands them over
 * together so no consumer can get it wrong.
 *
 * The two arms mirror the worker's own: a spatial document travels as the
 * bytes nobody on this thread decoded, a markdown one as the body it has
 * instead of boxes.
 */
export type DocumentOutlineSource =
  | { readonly state: string; readonly snapshot: Uint8Array; readonly body?: undefined }
  | { readonly state: string; readonly body: string; readonly snapshot?: undefined }

export function outlineFromSpatial(canvas: SpatialCanvas): FaviconRect[] {
  return canvas.nodes.map((node) => ({
    x: node.x,
    y: node.y,
    w: node.width,
    h: node.height,
    color: resolveRectColor(node.color),
  }))
}

/** A box worth drawing: finite, and with area a projection can scale. */
function isDrawable(bbox: { x: number; y: number; w: number; h: number }): boolean {
  return (
    Number.isFinite(bbox.x) &&
    Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.w) &&
    Number.isFinite(bbox.h) &&
    bbox.w > 0 &&
    bbox.h > 0
  )
}

/**
 * Top-level blocks only. A run's box sits INSIDE its block's, so keeping both
 * draws the same ink twice — and lets a long paragraph's individual words
 * outvote the heading above it once `projectRectsToBoard` caps by area.
 */
export function outlineFromScene(scene: Scene): FaviconRect[] {
  const rects: FaviconRect[] = []
  for (const node of scene.nodes as readonly SceneNode[]) {
    const bbox = (node as { bbox?: { x: number; y: number; w: number; h: number } }).bbox
    if (bbox === undefined || !isDrawable(bbox)) continue
    rects.push({ x: bbox.x, y: bbox.y, w: inkWidth(node) ?? bbox.w, h: bbox.h })
  }
  return rects
}

/**
 * How far a block's text actually reaches, which is NOT its box: layout
 * gives every top-level block the full column width, so a heading of three
 * words and a paragraph of forty declare the same one.
 *
 * That difference is the entire reason to draw an outline rather than a
 * plain scrollbar — a column of equal bars carries no information about the
 * document. `undefined` for a block with no runs to measure (a rule, an
 * image), whose own box is the honest answer.
 */
function inkWidth(node: SceneNode): number | undefined {
  const runs = (node as { runs?: readonly { bbox: { x: number; w: number } }[] }).runs
  if (runs === undefined || runs.length === 0) return undefined
  let widest = 0
  for (const run of runs) {
    const right = run.bbox.x + run.bbox.w
    if (Number.isFinite(right) && right > widest) widest = right
  }
  return widest > 0 ? widest : undefined
}
