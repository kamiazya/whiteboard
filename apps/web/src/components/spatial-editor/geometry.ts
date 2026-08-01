/**
 * Pure hit-testing and selection-handle geometry. Reads node boxes straight
 * off the `SpatialCanvas` model — the same `{x, y, width, height}` fields
 * `layoutSpatialCanvas`'s `chromeShape` emits as each node's bbox — so
 * selection and rendering can never disagree about where a node is. See
 * `scene-render.test.ts`'s drift guard.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { Point } from './viewport.js'

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface NodeBox {
  readonly id: string
  readonly box: Box
}

/** One box per node, in document order — the order the scene paints them. */
export function indexNodeBoxes(canvas: SpatialCanvas): readonly NodeBox[] {
  return canvas.nodes.map((node) => ({
    id: node.id,
    box: { x: node.x, y: node.y, width: node.width, height: node.height },
  }))
}

/** Inclusive of the box edge — a point exactly on the boundary is "inside". */
export function boxContains(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  )
}

/**
 * Returns the id of the topmost node under `point`, or undefined for empty
 * space. "Topmost" is document-order-last, matching paint order (later
 * nodes draw over earlier ones).
 */
export function hitTest(boxes: readonly NodeBox[], point: Point): string | undefined {
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const candidate = boxes[i]
    if (candidate !== undefined && boxContains(candidate.box, point)) {
      return candidate.id
    }
  }
  return undefined
}

export type ResizeHandleKind = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export interface ResizeHandle {
  readonly kind: ResizeHandleKind
  readonly box: Box
}

/** Constant on-screen handle size in CSS px, at zoom 1. */
const HANDLE_SIZE_PX = 8

/**
 * Eight resize-handle hit boxes centered on a node's corners/edge midpoints,
 * in canvas space. Sized by `HANDLE_SIZE_PX / zoom` so the handle stays a
 * constant on-screen size regardless of viewport zoom.
 */
export function resizeHandleBoxes(box: Box, zoom: number): readonly ResizeHandle[] {
  const size = HANDLE_SIZE_PX / zoom
  const half = size / 2
  const centers: Array<{ kind: ResizeHandleKind; x: number; y: number }> = [
    { kind: 'nw', x: box.x, y: box.y },
    { kind: 'n', x: box.x + box.width / 2, y: box.y },
    { kind: 'ne', x: box.x + box.width, y: box.y },
    { kind: 'e', x: box.x + box.width, y: box.y + box.height / 2 },
    { kind: 'se', x: box.x + box.width, y: box.y + box.height },
    { kind: 's', x: box.x + box.width / 2, y: box.y + box.height },
    { kind: 'sw', x: box.x, y: box.y + box.height },
    { kind: 'w', x: box.x, y: box.y + box.height / 2 },
  ]
  return centers.map(({ kind, x, y }) => ({
    kind,
    box: { x: x - half, y: y - half, width: size, height: size },
  }))
}
