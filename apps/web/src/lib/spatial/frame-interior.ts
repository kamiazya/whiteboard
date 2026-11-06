import {
  frameHolds,
  frameLabel,
  isFrame,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { Box } from './geometry.js'
import { boxContains, boxesIntersect, indexNodeBoxes } from './geometry.js'
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
 * The name strips of every named frame: space a new box should not land on,
 * since a note over a frame's name hides what the frame is called.
 */
function nameStrips(nodes: readonly SpatialNode[]): Box[] {
  return nodes.filter((node) => isFrame(node) && frameLabel(node) !== undefined).map(frameTitleBox)
}

/** What a created box should not land on: every node, and every frame's name. */
export function creationObstacles(canvas: SpatialCanvas): Box[] {
  return [...indexNodeBoxes(canvas).map((b) => b.box), ...nameStrips(canvas.nodes)]
}

/**
 * The clearance a placed box keeps from its neighbours and its frame's
 * edges: under about this two boxes read as one shape, and it is the gap
 * tidy keeps.
 */
export const PLACEMENT_GAP_PX = 32

/**
 * Where the next box of `size` goes INSIDE `frame`: the first cell, reading
 * row by row, a gap clear of the frame's edges and of everything already
 * there. A full frame answers a spot just past its own content and the box it
 * has to grow to so the note fits — a note asked for inside a frame belongs to
 * it, and one placed outside would not.
 *
 * Growing reaches into space the frame did not cover, so it goes the first
 * way, of down, right and left, whose new strip is a gap clear of every
 * neighbour: a frame grown over another frame's notes would take them, and one
 * grown through a neighbour frame's border reads as one shape with it. Only a
 * frame boxed in on all three sides grows down regardless.
 */
export function nextSpotInFrame(
  frame: SpatialNode,
  nodes: readonly SpatialNode[],
  size: Size,
): FrameSpot {
  const gap = PLACEMENT_GAP_PX
  // What is inside the frame, or reaches into it; the frames around it hold
  // it rather than block it.
  const blockers = nodes.filter(
    (node) =>
      node.id !== frame.id &&
      !frameHolds(node, frame) &&
      node.x < frame.x + frame.width &&
      frame.x < node.x + node.width &&
      node.y < frame.y + frame.height &&
      frame.y < node.y + node.height,
  )
  const room: FrameRoom = {
    frame,
    nodes,
    blockers,
    size,
    clear: (x, y) =>
      blockers.every(
        (b) =>
          x + size.width + gap <= b.x ||
          b.x + b.width + gap <= x ||
          y + size.height + gap <= b.y ||
          b.y + b.height + gap <= y,
      ),
  }
  const left = frame.x + gap
  const right = frame.x + frame.width - gap
  for (const y of rowsOf(room)) {
    for (let x = left; x === left || x + size.width <= right; x += size.width + gap) {
      if (room.clear(x, y)) return { center: centreOf(size, x, y) }
    }
  }
  return grownSpot(room)
}

type Size = { readonly width: number; readonly height: number }

interface FrameSpot {
  readonly center: Point
  /** The whole box the frame grows to first, when it has to grow. */
  readonly grow?: Box
}

/** What placing in one frame works from. */
interface FrameRoom {
  readonly frame: SpatialNode
  readonly nodes: readonly SpatialNode[]
  readonly blockers: readonly SpatialNode[]
  readonly size: Size
  /** Whether a box of `size` at (x, y) keeps the gap from every blocker. */
  readonly clear: (x: number, y: number) => boolean
}

const centreOf = (size: Size, x: number, y: number): Point => ({
  x: x + size.width / 2,
  y: y + size.height / 2,
})

/** The top of each row a box fits in, within the frame's current height. */
function rowsOf({ frame, size }: FrameRoom): number[] {
  const rows: number[] = []
  const bottom = frame.y + frame.height
  for (let y = frame.y + PLACEMENT_GAP_PX; y + size.height + PLACEMENT_GAP_PX <= bottom; ) {
    rows.push(y)
    y += size.height + PLACEMENT_GAP_PX
  }
  return rows
}

/** A full frame's next spot, and the box it grows to: see `nextSpotInFrame`. */
function grownSpot(room: FrameRoom): FrameSpot {
  const { frame, nodes, blockers, size } = room
  const gap = PLACEMENT_GAP_PX
  // The frame's own content: a neighbour frame merely reaching in is not
  // something to stack under.
  const content = blockers.filter((b) => !isFrame(b) || frameHolds(frame, b))
  // Everything the frame neither is, sits in, nor holds — a frame reaching
  // in from beside it included.
  const outside = nodes.filter(
    (node) => node.id !== frame.id && !frameHolds(node, frame) && !frameHolds(frame, node),
  )
  const reachable = (strip: Box) => outside.every((node) => !boxesIntersect(strip, node))
  const firstRow = (x: number) => rowsOf(room).find((y) => room.clear(x, y))

  const downY = Math.max(frame.y, ...content.map((b) => b.y + b.height)) + gap
  const height = downY + size.height + gap - frame.y
  const down = { center: centreOf(size, frame.x + gap, downY) }
  if (height <= frame.height) return down
  const grownDown = { ...down, grow: { x: frame.x, y: frame.y, width: frame.width, height } }
  const below = frame.y + frame.height
  if (reachable({ x: frame.x, y: below, width: frame.width, height: height - frame.height + gap }))
    return grownDown

  const rightX = Math.max(frame.x, ...content.map((b) => b.x + b.width)) + gap
  const rightY = firstRow(rightX)
  const width = rightX + size.width + gap - frame.x
  const rightStrip = {
    x: frame.x + frame.width,
    y: frame.y,
    width: width - frame.width + gap,
    height: frame.height,
  }
  if (rightY !== undefined && reachable(rightStrip))
    return {
      center: centreOf(size, rightX, rightY),
      grow: { x: frame.x, y: frame.y, width, height: frame.height },
    }

  const leftX = Math.min(frame.x + frame.width, ...content.map((b) => b.x)) - gap - size.width
  const leftY = firstRow(leftX)
  const x = leftX - gap
  const leftStrip = { x: x - gap, y: frame.y, width: frame.x - x + gap, height: frame.height }
  if (leftY !== undefined && reachable(leftStrip))
    return {
      center: centreOf(size, leftX, leftY),
      grow: { x, y: frame.y, width: frame.x + frame.width - x, height: frame.height },
    }
  return grownDown
}

/**
 * The frame a note asked for while `selected` is selected belongs in: the
 * selected frame itself, or the innermost frame holding the selected node —
 * a note added next to one in a frame is added to that frame's contents.
 */
export function frameForNewNote(
  selected: SpatialNode | undefined,
  nodes: readonly SpatialNode[],
): SpatialNode | undefined {
  if (selected === undefined) return undefined
  if (isFrame(selected)) return selected
  const holders = nodes.filter(
    (node) => node.id !== selected.id && isFrame(node) && frameHolds(node, selected),
  )
  return holders.reduce<SpatialNode | undefined>(
    (inner, node) =>
      inner === undefined || node.width * node.height < inner.width * inner.height ? node : inner,
    undefined,
  )
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
