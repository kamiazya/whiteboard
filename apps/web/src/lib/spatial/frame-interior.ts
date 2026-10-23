import { frameLabel, isFrame, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { Box } from './geometry.js'
import { boxContains } from './geometry.js'
import type { Point } from './viewport.js'

/** How far above a frame's top edge its name starts (the renderer's label band). */
export const FRAME_TITLE_OFFSET_PX = 44
/** The height the in-place name editor takes inside that band. */
export const FRAME_TITLE_EDITOR_HEIGHT_PX = 40

/**
 * The strip a frame's name is drawn in: the full width of the frame, from
 * `FRAME_TITLE_OFFSET_PX` above its top edge down to that edge. The one box
 * the name editor sits on and a double-click is judged against.
 */
function frameTitleBox(frame: SpatialNode): Box {
  return {
    x: frame.x,
    y: frame.y - FRAME_TITLE_OFFSET_PX,
    width: frame.width,
    height: FRAME_TITLE_OFFSET_PX,
  }
}

/**
 * The frame whose NAME is under `at`. A frame with no name draws nothing
 * above itself, so it has no strip to point at; later frames paint over
 * earlier ones, so the last match wins.
 */
export function frameTitleAt(nodes: readonly SpatialNode[], at: Point): string | undefined {
  const named = nodes.filter(
    (node) =>
      isFrame(node) && frameLabel(node) !== undefined && boxContains(frameTitleBox(node), at),
  )
  return named[named.length - 1]?.id
}

/**
 * Where a box of `size` centred on `at` stays inside `frame`, when it fits:
 * a note made near a frame's edge would otherwise straddle it and no longer
 * belong to it. A frame smaller than the box keeps the point it was given.
 */
export function pointInsideFrame(
  frame: SpatialNode,
  at: Point,
  size: { readonly width: number; readonly height: number },
): Point {
  const clamp = (value: number, low: number, high: number) =>
    high < low ? value : Math.min(Math.max(value, low), high)
  return {
    x: clamp(at.x, frame.x + size.width / 2, frame.x + frame.width - size.width / 2),
    y: clamp(at.y, frame.y + size.height / 2, frame.y + frame.height - size.height / 2),
  }
}
