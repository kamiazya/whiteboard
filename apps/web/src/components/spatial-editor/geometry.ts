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
  /** True for container frames (groups) — hit-testing yields them to content nodes. */
  readonly container?: boolean
  readonly box: Box
}

/** One box per node, in document order — the order the scene paints them. */
export function indexNodeBoxes(canvas: SpatialCanvas): readonly NodeBox[] {
  return canvas.nodes.map((node) => ({
    id: node.id,
    ...(node.type === 'group' ? { container: true } : {}),
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
  // Container frames (groups) are unfilled, so a content node under the
  // pointer is fully visible even when the frame paints later — the click
  // lands on what the user sees. Membership is geometric in this app, so
  // z-order between a member and its frame carries no occlusion meaning.
  // A frame is hit only where no content node is (its padding area),
  // topmost frame first when frames nest.
  let containerHit: string | undefined
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const candidate = boxes[i]
    if (candidate === undefined || !boxContains(candidate.box, point)) continue
    if (candidate.container !== true) return candidate.id
    containerHit ??= candidate.id
  }
  return containerHit
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

/** Cascade step (canvas-space px) used by `findFreeSpot` between successive placement attempts. */
const CASCADE_STEP_PX = 24
/** Bounded search depth: `findFreeSpot` never loops forever on a densely occupied canvas. */
const MAX_CASCADE_STEPS = 50

function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * Finds a placement for a `size`-shaped box, centered on `preferred`, that
 * does not overlap any box in `occupied`. Cascades diagonally in fixed
 * `CASCADE_STEP_PX` steps from `preferred` until a non-colliding spot is
 * found or the bounded search is exhausted, in which case it degrades to
 * the last candidate rather than looping forever or throwing — an
 * occasional overlap on a densely packed canvas is an accepted degradation,
 * not a correctness bug. Deterministic: the same `preferred`/`size`/
 * `occupied` always returns the same point.
 */
export function findFreeSpot(
  preferred: Point,
  size: { readonly width: number; readonly height: number },
  occupied: readonly Box[],
): Point {
  const candidateAt = (step: number): Point => ({
    x: preferred.x + step * CASCADE_STEP_PX,
    y: preferred.y + step * CASCADE_STEP_PX,
  })
  const boxAt = (center: Point): Box => ({
    x: Math.round(center.x - size.width / 2),
    y: Math.round(center.y - size.height / 2),
    width: size.width,
    height: size.height,
  })
  for (let step = 0; step < MAX_CASCADE_STEPS; step += 1) {
    const candidate = candidateAt(step)
    const box = boxAt(candidate)
    if (!occupied.some((other) => boxesIntersect(box, other))) return candidate
  }
  return candidateAt(MAX_CASCADE_STEPS)
}

/** Which axes a given handle moves, and in which direction, as a corner/edge is dragged. */
export const HANDLE_SIGN: Record<ResizeHandleKind, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
}

/**
 * Resizes `startBox` by a raw screen-space delta, anchor-preserving: moving
 * a min-side handle (x=-1/y=-1) shifts the origin so the OPPOSITE corner
 * stays fixed; the max-side handles only grow/shrink from the origin.
 * Shared by pointer-drag (gestures.ts) and keyboard-nudge (SpatialEditor)
 * resize paths so both compute the identical result.
 */
export function resizeBoxByDelta(
  startBox: Box,
  handle: ResizeHandleKind,
  rawDx: number,
  rawDy: number,
): Box {
  const sign = HANDLE_SIGN[handle]
  // Clamp the delta to the box's own size BEFORE deriving x/y from it: an
  // overshoot must floor width/height at 0 without sliding the origin past
  // where the opposite corner was meant to stay fixed.
  const dx = sign.x === -1 ? Math.min(rawDx, startBox.width) : Math.max(rawDx, -startBox.width)
  const dy = sign.y === -1 ? Math.min(rawDy, startBox.height) : Math.max(rawDy, -startBox.height)
  return {
    x: sign.x === -1 ? startBox.x + dx : startBox.x,
    y: sign.y === -1 ? startBox.y + dy : startBox.y,
    width: startBox.width + sign.x * dx,
    height: startBox.height + sign.y * dy,
  }
}

/** The smallest box covering all of `boxes`; `undefined` for an empty selection. */
export function unionBox(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) return undefined
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** A node scaled to nothing can never be grabbed to grow again. */
const MIN_SCALED_EXTENT_PX = 1

/**
 * Floors a scaled extent at one pixel — but only if there was an extent to
 * begin with. A zero-width node is legal in JSON Canvas, and resizing the
 * selection AROUND it is no reason to silently give it a width it never had.
 */
function scaleExtent(extent: number, scale: number): number {
  if (extent <= 0) return extent
  return Math.max(MIN_SCALED_EXTENT_PX, Math.round(extent * scale))
}

/**
 * Re-places one member of a multi-selection after its enclosing box has been
 * resized, preserving where the member sat inside that box and how much of it
 * it filled.
 *
 * This is what makes resize handles around a whole selection mean the same
 * thing as handles around one node: the group is treated as a single object,
 * so the arrangement inside it survives the drag.
 *
 * Totality matters here — it runs on whatever the pointer produced, and a
 * NaN coordinate would reach the canvas schema. A collapsed axis on the
 * enclosing box has no ratio to preserve, so that axis passes through
 * unscaled rather than dividing by zero; results are rounded because JSON
 * Canvas geometry is integer, and floored at one pixel because rounding a
 * heavy shrink otherwise lands on zero.
 */
export function scaleBoxWithin(startEnclosing: Box, nextEnclosing: Box, box: Box): Box {
  const scaleX = startEnclosing.width > 0 ? nextEnclosing.width / startEnclosing.width : 1
  const scaleY = startEnclosing.height > 0 ? nextEnclosing.height / startEnclosing.height : 1
  return {
    x: Math.round(nextEnclosing.x + (box.x - startEnclosing.x) * scaleX),
    y: Math.round(nextEnclosing.y + (box.y - startEnclosing.y) * scaleY),
    width: scaleExtent(box.width, scaleX),
    height: scaleExtent(box.height, scaleY),
  }
}

/**
 * Minimum distance from a point to a polyline (canvas coordinates). Used to
 * hit-test edges, which have no area of their own — the caller compares the
 * result against a zoom-adjusted tolerance.
 */
export function distanceToPolyline(
  point: { x: number; y: number },
  path: readonly { x: number; y: number }[],
): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY
  if (path.length === 1) return Math.hypot(point.x - path[0].x, point.y - path[0].y)
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq))
    const distance = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
    if (distance < min) min = distance
  }
  return min
}
