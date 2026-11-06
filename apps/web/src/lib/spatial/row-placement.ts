/**
 * Where the next of a run of created boxes goes so the run reads in the order
 * it was made: right of the last row, on that row's top line,
 * and once the row would leave the view, a new row below its left end — the
 * way text fills a page. Pure, so the frame and the note paths share it.
 */
import { frameHolds } from '@kamiazya/whiteboard-model'
import { type Box, boxesIntersect } from './geometry.js'
import type { Point } from './viewport.js'

export interface RowPlacementInput {
  /**
   * Every box of the run's kind, at least one. The row extended is the LAST
   * in reading order — the lowest top line — since a node list's order is
   * paint order, not the order things were made in.
   */
  readonly peers: readonly [Box, ...Box[]]
  readonly size: { readonly width: number; readonly height: number }
  /** What the new box may not touch, already grown by whatever clearance it keeps. */
  readonly obstacles: readonly Box[]
  /** The canvas-space rectangle on screen; undefined means anywhere counts as seen. */
  readonly visible: Box | undefined
  /** The horizontal gap between neighbours in a row. */
  readonly gap: number
  /** The vertical distance from a row's lowest bottom to the next row's top. */
  readonly rowGap: number
}

/** How many rows below the last a wrap looks at before giving up on the view. */
const MAX_WRAP_ROWS = 20
/** How many obstacles one row steps past before it counts as blocked. */
const MAX_ROW_STEPS = 64

/**
 * The top-left corner of the next box. Right of the row when that is on
 * screen; else the first row below, at the row's left end, with a free spot on
 * screen; else right of the row anyway, for the caller to pan to.
 */
export function nextInRow(input: RowPlacementInput): Point {
  const { peers, size, obstacles, visible, gap, rowGap } = input
  const lowestTop = Math.max(...peers.map((peer) => peer.y))
  // A box dragged a few pixels off the line still belongs to the row.
  const members = peers.filter((peer) => lowestTop - peer.y <= gap / 2)
  const top = Math.min(...members.map((b) => b.y))
  const rowLeft = Math.min(...members.map((b) => b.x))
  const rowRight = Math.max(...members.map((b) => b.x + b.width))
  const rowBottom = Math.max(...members.map((b) => b.y + b.height))
  const seen = (box: Box) => visible === undefined || frameHolds(visible, box)

  /** The first free box on the line at `y`, from `x` rightwards. */
  const slide = (x: number, y: number): Box | undefined => {
    let box: Box = { x, y, width: size.width, height: size.height }
    for (let step = 0; step < MAX_ROW_STEPS; step += 1) {
      const hit = obstacles.find((other) => boxesIntersect(box, other))
      if (hit === undefined) return box
      box = { ...box, x: hit.x + hit.width }
    }
    return undefined
  }

  const right = slide(rowRight + gap, top)
  if (right !== undefined && seen(right)) return { x: right.x, y: right.y }

  let firstWrap: Box | undefined
  let y = rowBottom + rowGap
  for (let rowIndex = 0; rowIndex < MAX_WRAP_ROWS; rowIndex += 1) {
    const box = slide(rowLeft, y)
    if (box !== undefined) {
      if (seen(box)) return { x: box.x, y: box.y }
      firstWrap ??= box
    }
    y += size.height + rowGap
  }
  // Nowhere on screen either way: the row goes on, since panning along a row
  // keeps the order it reads in, where a row begun off screen below would not.
  const chosen = right ?? firstWrap ?? { x: rowRight + gap, y: top }
  return { x: chosen.x, y: chosen.y }
}
