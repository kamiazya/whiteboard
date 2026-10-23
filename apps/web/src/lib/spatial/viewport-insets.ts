import type { ViewportOcclusion } from './viewport.js'

/**
 * Panels that paint OVER the canvas rather than beside it.
 *
 * A column that takes width out of the canvas needs no entry here: the root
 * shrinks and every viewport verb already measures the root. What a viewport
 * cannot see for itself is a surface that covers part of the root — the
 * narrow-width inspector sheet — so that surface registers its element and the
 * editor measures what it covers. A registry rather than a DOM query keeps the
 * editor ignorant of where the page mounts its panels.
 */
const occluders = new Set<HTMLElement>()
const listeners = new Set<() => void>()

export function registerOccluder(element: HTMLElement): () => void {
  occluders.add(element)
  for (const listener of listeners) listener()
  return () => {
    occluders.delete(element)
    for (const listener of listeners) listener()
  }
}

export function onOccludersChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function currentOccluders(): readonly HTMLElement[] {
  return [...occluders]
}

interface RectLike {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** A strip this close to the full width (or height) of the root counts as spanning it. */
const SPAN_TOLERANCE_PX = 2

type Edge = keyof Required<ViewportOcclusion>

/** The edge of `root` a cover is a strip along, with its depth; undefined for anything else. */
function stripOf(root: RectLike, cover: RectLike): { edge: Edge; depth: number } | undefined {
  const x0 = Math.max(root.left, cover.left)
  const x1 = Math.min(root.right, cover.right)
  const y0 = Math.max(root.top, cover.top)
  const y1 = Math.min(root.bottom, cover.bottom)
  if (x1 <= x0 || y1 <= y0) return undefined
  const coversWidth = x1 - x0 >= root.right - root.left - SPAN_TOLERANCE_PX
  const coversHeight = y1 - y0 >= root.bottom - root.top - SPAN_TOLERANCE_PX
  if (coversWidth === coversHeight) return undefined
  if (coversWidth) {
    if (y1 >= root.bottom - SPAN_TOLERANCE_PX) return { edge: 'bottom', depth: y1 - y0 }
    if (y0 <= root.top + SPAN_TOLERANCE_PX) return { edge: 'top', depth: y1 - y0 }
    return undefined
  }
  if (x1 >= root.right - SPAN_TOLERANCE_PX) return { edge: 'right', depth: x1 - x0 }
  if (x0 <= root.left + SPAN_TOLERANCE_PX) return { edge: 'left', depth: x1 - x0 }
  return undefined
}

/**
 * How much of each edge of `root` is covered by chrome in `covers`.
 *
 * Only a cover that spans the root on one axis and reaches an edge of it is an
 * inset: a floating card in the middle hides a spot, not a strip of the visible
 * area, and pretending otherwise would push every node away from it.
 */
export function insetsFromCovers(
  root: RectLike,
  covers: readonly RectLike[],
): Required<ViewportOcclusion> {
  const insets = { top: 0, bottom: 0, left: 0, right: 0 }
  for (const cover of covers) {
    const strip = stripOf(root, cover)
    if (strip !== undefined) insets[strip.edge] = Math.max(insets[strip.edge], strip.depth)
  }
  return insets
}

export function sameInsets(a: ViewportOcclusion, b: ViewportOcclusion): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right
}
