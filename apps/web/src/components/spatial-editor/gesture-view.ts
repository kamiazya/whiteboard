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
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { EdgeSides, Scene } from '@kamiazya/whiteboard-canvas-render'
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
