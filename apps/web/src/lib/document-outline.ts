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
    rects.push({ x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h })
  }
  return rects
}
