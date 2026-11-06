/**
 * Where a selected path's more-actions chip goes, so it never sits on one of
 * that path's own handles.
 *
 * The chip's home is above the top-right corner of what is selected, the
 * place the node chip takes relative to its box. A stroke that ENDS at that
 * corner has its end handle there too, and a chip over the handle is a
 * handle nobody can grab — on a finger, whose target is 44px, the two share
 * most of their area. So the home is only the first of several places, and
 * the first one clear of every handle wins.
 *
 * Pure: canvas coordinates in, a canvas-space corner out. Sizes arrive
 * already divided by the zoom, so the caller decides what a screen pixel is.
 */

import { frameHolds } from '@kamiazya/whiteboard-model'
import type { Point } from './viewport.js'

export interface PathChipRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PathChipInputs {
  /** Every point of the selected paths, as drawn. */
  readonly points: readonly Point[]
  /** The centres of the handles the selection draws (its ends and stored bends). */
  readonly handles: readonly Point[]
  /** Half the side of the largest handle's PRESS target. */
  readonly handleHalf: number
  /** The chip's side. */
  readonly size: number
  /** Room kept between the chip and the paths' bounds, and around each handle. */
  readonly gap: number
  /** The canvas area on screen; a place inside it is preferred when one is clear. */
  readonly visible?: PathChipRect
}

function overlaps(a: PathChipRect, b: PathChipRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * The chip's top-left corner, or `undefined` when there is no path to place
 * it by.
 *
 * Tries, in order: above the top-right corner, above the top-left, beside
 * the top-right, below the bottom-right, below the bottom-left, beside the
 * top-left. A place on screen beats one off it; among those, the earliest
 * clear one wins. When none is clear the chip rises above the top-right
 * corner by a handle's reach — every handle sits on the paths, so nothing
 * can be up there.
 */
export function placePathChip(inputs: PathChipInputs): Point | undefined {
  const { points, handles, handleHalf, size, gap, visible } = inputs
  if (points.length < 2) return undefined
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const candidates: Point[] = [
    { x: right - size, y: top - size - gap },
    { x: left, y: top - size - gap },
    { x: right + gap, y: top },
    { x: right - size, y: bottom + gap },
    { x: left, y: bottom + gap },
    { x: left - size - gap, y: top },
  ]
  const reach = handleHalf + gap
  const blocked = handles.map((h) => ({
    x: h.x - reach,
    y: h.y - reach,
    width: reach * 2,
    height: reach * 2,
  }))
  const rectOf = (corner: Point): PathChipRect => ({ ...corner, width: size, height: size })
  const clear = candidates.filter((corner) => !blocked.some((b) => overlaps(rectOf(corner), b)))
  const onScreen =
    visible === undefined ? [] : clear.filter((corner) => frameHolds(visible, rectOf(corner)))
  return onScreen[0] ?? clear[0] ?? { x: right - size, y: top - reach - size }
}
