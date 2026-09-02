/**
 * The shared derivations behind every live-gesture view: which nodes a
 * gesture carries, what the canvas looks like at the live preview
 * geometry, and which edge sides stay frozen for the gesture's duration.
 *
 * ONE producer for the editor's layers — the static base excludes
 * `carried`, the ghost/live-node layers draw it, and the live-edge layer
 * routes `liveNodesFor` with `frozenSidesOf` — so a new gesture kind means
 * extending these functions once instead of teaching each layer
 * separately. Deliberately NOT a pipeline object: the layers recompute at
 * different cadences (the static base once per gesture, the live layers
 * every pointer frame), and that split is the perf design — these helpers
 * stay cheap enough to call at either cadence.
 */

import type { BoundingBox, EdgeSides, Scene } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { carriedWithDrag } from './drag-preview.js'
import type { Box } from './geometry.js'
import type { GestureState } from './gestures.js'

/**
 * Node ids travelling with the gesture: excluded from the static base and
 * drawn by the live layers. A move carries the grabbed node, the
 * multi-selection extras, and a grabbed frame's contained members (the
 * same set the commit moves); a resize carries exactly the resized node;
 * every other gesture carries nothing.
 */
export function carriedByGesture(
  canvas: SpatialCanvas,
  gesture: GestureState,
  extraIds: ReadonlySet<string>,
  isLocked: (id: string) => boolean,
): ReadonlySet<string> {
  switch (gesture.kind) {
    case 'moving':
      return carriedWithDrag(canvas, gesture, extraIds, isLocked)
    case 'resizing':
      return new Set([gesture.nodeId])
    default:
      return new Set()
  }
}

/**
 * The canvas extension with only the comments that ride on a CARRIED node
 * (`carried === true`) or only those that do not (`carried === false`).
 *
 * A node-anchored comment is drawn at its target's top-right corner, so it
 * belongs to whichever layer draws the target: the ghost/live-node layer
 * while the node travels, the static base otherwise. A point-anchored
 * comment is anchored to the canvas and stays in the base. Splitting it
 * here, rather than letting the base keep every comment, is what stops the
 * base drawing a stale copy at the pre-gesture corner while the ghost draws
 * the live one — `composeComments` falls back to the comment's stored x/y
 * when its target is missing from the nodes it is given, and the base is
 * given the canvas WITHOUT the carried nodes.
 */
export function commentExtensionFor(
  canvas: SpatialCanvas,
  carriedIds: ReadonlySet<string>,
  carried: boolean,
): SpatialCanvas['x-whiteboard'] {
  const extension = canvas['x-whiteboard']
  if (extension?.comments === undefined) return carried ? undefined : extension
  return {
    ...extension,
    comments: extension.comments.filter(
      (comment) =>
        (comment.targetNodeId !== undefined && carriedIds.has(comment.targetNodeId)) === carried,
    ),
  }
}

/**
 * What a riding comment's bubble must not cover in the GHOST render: the
 * nodes staying behind, and the bubbles of the comments staying behind.
 *
 * The ghost re-places the bubbles of the comments it carries, and it has to
 * reach the same quadrant the committed scene chose or the bubble jumps the
 * moment the press lands. That means scoring against what the COMMITTED
 * placement scored against — which excludes the carried comments' own
 * bubbles. Counting a comment's own bubble is worse than useless: it covers
 * exactly the candidate the committed run picked, so it steers the ghost
 * away from the right answer every time.
 *
 * The committed placer also works incrementally, so a comment is scored only
 * against bubbles placed BEFORE it. This returns one set for the whole ghost
 * render instead, which over-counts the bystander bubbles that would have
 * come later. That is a tie-breaker's worth of difference and it keeps the
 * contract one list; the exact form would need per-comment obstacle sets
 * through `layoutSpatialCanvas`.
 */
export function ghostCommentObstacles(
  canvas: SpatialCanvas,
  committed: Scene,
  carried: ReadonlySet<string>,
): BoundingBox[] {
  const riding = new Set(
    (commentExtensionFor(canvas, carried, true)?.comments ?? []).map((comment) => comment.id),
  )
  return [
    ...canvas.nodes
      .filter((node) => !carried.has(node.id) && node.type !== 'group')
      .map((node) => ({ x: node.x, y: node.y, w: node.width, h: node.height })),
    ...committed.nodes.flatMap((node) => {
      if (node.kind !== 'shape' || node.commentChrome !== true) return []
      const id = node.id
      if (id === undefined || !id.endsWith(BUBBLE_SUFFIX)) return []
      return riding.has(id.slice(0, -BUBBLE_SUFFIX.length)) ? [] : [node.bbox]
    }),
  ]
}

/** How `composeComments` keys a comment's bubble shape. */
const BUBBLE_SUFFIX = '/bubble'

/**
 * The canvas' nodes with the gesture's transform applied at the live
 * preview geometry: a move translates every carried node by the preview
 * delta, a resize reshapes the one resized node to the preview box, and
 * any other gesture leaves the nodes untouched.
 */
export function liveNodesFor(
  canvas: SpatialCanvas,
  gesture: GestureState,
  previewBox: Box,
  carried: ReadonlySet<string>,
): readonly SpatialNode[] {
  switch (gesture.kind) {
    case 'moving': {
      const dx = previewBox.x - gesture.startX
      const dy = previewBox.y - gesture.startY
      return canvas.nodes.map((n) => (carried.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n))
    }
    case 'resizing':
      return canvas.nodes.map((n) =>
        n.id === gesture.nodeId
          ? {
              ...n,
              x: previewBox.x,
              y: previewBox.y,
              width: previewBox.width,
              height: previewBox.height,
            }
          : n,
      )
    default:
      return canvas.nodes
  }
}

/**
 * Each committed edge's resolved sides, frozen for a gesture's duration:
 * per-frame surfaces trade crossing optimization for route stability (see
 * `edgeSideOverrides` in canvas-render), and the committed scene is the
 * one authority on what the sides were before the gesture began.
 */
export function frozenSidesOf(scene: Scene): ReadonlyMap<string, EdgeSides> {
  return new Map(
    scene.nodes.flatMap((n) =>
      n.kind === 'edge' ? [[n.id, { fromSide: n.fromSide, toSide: n.toSide }] as const] : [],
    ),
  )
}

/**
 * How far a carried node travels before its edges' sides are re-optimized.
 * Re-siding every frame costs ~8-14ms (the optimizer's trial loop) and a
 * side decision rarely changes within a few pixels, so live drag reuses
 * the last optimized sides until the node has moved a full step; the drop
 * still runs the full optimization on the committed render.
 */
export const CARRIED_RESIDE_STEP_PX = 16

/** The last optimized sides for the gesture's carried edges, anchored at
 * the preview position they were computed for. */
export interface CarriedSideCache {
  readonly key: string
  readonly anchorX: number
  readonly anchorY: number
  readonly sides: ReadonlyMap<string, EdgeSides>
}

/** Order-independent identity of the carried edge set. */
export function carriedSideCacheKey(carriedEdgeIds: ReadonlySet<string>): string {
  return [...carriedEdgeIds].sort().join(' ')
}

export function canReuseCarriedSides(
  cache: CarriedSideCache | null,
  key: string,
  x: number,
  y: number,
): boolean {
  return (
    cache !== null &&
    cache.key === key &&
    Math.hypot(x - cache.anchorX, y - cache.anchorY) < CARRIED_RESIDE_STEP_PX
  )
}
