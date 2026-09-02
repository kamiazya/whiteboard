// Snapping of the in-flight gesture pointer, extracted from SpatialEditor as
// a pure function so the same code path serves the per-frame preview and the
// commit (both call it with the same inputs, which is what keeps the box
// landing exactly where the last frame drew it).

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { HANDLE_SIGN, type NodeBox } from './geometry.js'
import { carriedByGesture } from './gesture-view.js'
import type { GestureState } from './gestures.js'
import { type SnapBox, snapBox, snapEdge } from './snap.js'
import type { Point } from './viewport.js'

/**
 * Attraction radius in SCREEN pixels, converted to canvas units per gesture
 * so the pull feels the same at every zoom — a fixed canvas threshold would
 * be imperceptible zoomed out and violent zoomed in.
 */
const SNAP_THRESHOLD_SCREEN_PX = 6
/**
 * Grid pitch in canvas units. Deliberately wider than
 * `2 * SNAP_THRESHOLD_SCREEN_PX`: a pitch at or below that makes every
 * lattice line reachable from everywhere, which is silent rounding rather
 * than snapping, and it would out-pull the neighbour edges the user aimed
 * at. At 20 the grid attracts near a line and leaves the rest of the plane
 * alone.
 */
const SNAP_GRID_CANVAS_PX = 20

export interface SnapGestureInputs {
  gestureState: GestureState
  canvas: SpatialCanvas
  boxes: readonly NodeBox[]
  extraIds: ReadonlySet<string>
  isLocked: (nodeId: string) => boolean
  zoom: number
}

export interface SnapGestureResult {
  point: Point
  guides: { x: readonly number[]; y: readonly number[] }
}

/**
 * Nudges the POINTER, not the emitted command, so preview and commit see
 * the same value: the reducer derives both from `point`, and adjusting
 * only one of them would let the box render in one place and land in
 * another.
 *
 * Serves both gestures, but they snap DIFFERENT things: a move snaps the
 * box (three lines per axis — edge, centre, edge), a resize snaps only the
 * edge under the handle. Feeding a resize the move candidates would let
 * the box's own centre or far edge pull the handle, which reads as the
 * handle fighting the pointer.
 */
export function snapGesturePoint(
  raw: Point,
  suspended: boolean,
  inputs: SnapGestureInputs,
): SnapGestureResult {
  const { gestureState, canvas, boxes, extraIds, isLocked, zoom } = inputs
  const unchanged = { point: raw, guides: { x: [], y: [] } }
  if (suspended) return unchanged
  const options = {
    thresholdCanvasPx: SNAP_THRESHOLD_SCREEN_PX / zoom,
    gridSize: SNAP_GRID_CANVAS_PX,
  }

  if (gestureState.kind === 'resizing') {
    // Only the node being resized is excluded — nothing else moves with a
    // resize, so every other box stays a legitimate target.
    const others = boxes
      .filter((entry) => entry.id !== gestureState.nodeId)
      .map((entry) => entry.box)
    const sign = HANDLE_SIGN[gestureState.handle]
    const start = gestureState.startBox
    const guides: { x: number[]; y: number[] } = { x: [], y: [] }
    let point = raw

    // sign 0 means that axis is anchored (an edge handle moves one axis
    // only), -1 the leading edge travels, +1 the trailing one.
    if (sign.x !== 0) {
      const dx = raw.x - gestureState.startPoint.x
      const edge = sign.x === -1 ? start.x + dx : start.x + start.width + dx
      const snapped = snapEdge(edge, others, options, 'x')
      point = { ...point, x: raw.x + (snapped.position - edge) }
      if (snapped.guide !== undefined) guides.x.push(snapped.guide)
    }
    if (sign.y !== 0) {
      const dy = raw.y - gestureState.startPoint.y
      const edge = sign.y === -1 ? start.y + dy : start.y + start.height + dy
      const snapped = snapEdge(edge, others, options, 'y')
      point = { ...point, y: raw.y + (snapped.position - edge) }
      if (snapped.guide !== undefined) guides.y.push(snapped.guide)
    }
    return { point, guides }
  }

  if (gestureState.kind !== 'moving') return unchanged
  const moving = boxes.find((entry) => entry.id === gestureState.nodeId)
  if (moving === undefined) return unchanged

  const candidate: SnapBox = {
    x: gestureState.startX + (raw.x - gestureState.startPoint.x),
    y: gestureState.startY + (raw.y - gestureState.startPoint.y),
    width: moving.box.width,
    height: moving.box.height,
  }
  // Everything travelling WITH the drag is excluded: a multi-selection
  // member, or a frame's geometrically contained members (same rule the
  // commit uses). Left in, a carried node would attract its own carrier
  // and peg the gesture at a fixed offset.
  //
  // A LOCKED contained member is the exception, and it has to mirror the
  // commit path exactly: that path refuses to move a locked member with
  // its frame, so the member stays put and remains a legitimate
  // alignment target. Dropping it here would silently discard one.
  const carried = carriedByGesture(canvas, gestureState, extraIds, isLocked)

  const result = snapBox(
    candidate,
    boxes.filter((entry) => !carried.has(entry.id)).map((entry) => entry.box),
    options,
  )
  return {
    point: { x: raw.x + (result.x - candidate.x), y: raw.y + (result.y - candidate.y) },
    guides: { x: result.guidesX, y: result.guidesY },
  }
}
