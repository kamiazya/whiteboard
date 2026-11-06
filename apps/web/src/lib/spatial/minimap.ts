/**
 * Minimap geometry: fitting the canvas into a small overview box.
 *
 * Pure and total, like `snap.ts` and `align.ts` — no DOM, no viewport object,
 * no React. The caller supplies the content boxes, the visible canvas rect,
 * and the minimap's own size; it gets back one transform to project either
 * into minimap space.
 */

import {
  type SpatialPalette,
  type SpatialPresetKey,
  withDeclaredColours,
} from '@kamiazya/whiteboard-canvas-render'
import { endNode, isFiniteRect, type LineEnd, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { TagLibrary, VisualSymbolFacet } from '@kamiazya/whiteboard-plugin-visual'
import { resolveNodeSymbol } from '@kamiazya/whiteboard-plugin-visual'
import type { NodeBox } from './geometry.js'

export interface MinimapBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MinimapFit {
  /** Canvas units -> minimap units. Always finite and > 0. */
  readonly scale: number
  /** Canvas-space point that lands at the minimap's own origin. */
  readonly originX: number
  readonly originY: number
}

/** Fallback extent for a canvas with no area, so `scale` is never 0 or NaN. */
const MIN_EXTENT = 1

/** Clamps a derived span to something a finite affine transform can use. */
function finiteSpan(span: number): number {
  return Number.isFinite(span) ? Math.max(MIN_EXTENT, span) : MIN_EXTENT
}

/**
 * The transform placing `content` AND `viewportRect` inside a `size` box.
 *
 * The viewport is part of the fitted bounds on purpose: fitting content alone
 * would push the "you are here" marker outside the minimap the moment someone
 * pans away from their nodes, which is exactly when an overview is most
 * wanted.
 *
 * Never scales ABOVE 1. Magnifying a two-node canvas to fill the box would
 * make the overview lie about how much room the content occupies.
 */
export function fitMinimap(
  content: readonly MinimapBox[],
  viewportRect: MinimapBox,
  size: { readonly width: number; readonly height: number },
  padding: number,
): MinimapFit {
  const boxes = [...content, viewportRect].filter(isFiniteRect)
  const safePadding =
    Number.isFinite(padding) && padding > 0
      ? // Padding that would consume the whole box is treated as none: a
        // negative drawable area has no sensible fit, and silently inverting
        // it would put content outside the minimap.
        Math.min(padding, Math.max(0, Math.min(size.width, size.height) / 2 - MIN_EXTENT))
      : 0
  const drawable = {
    width: Math.max(MIN_EXTENT, (Number.isFinite(size.width) ? size.width : 0) - safePadding * 2),
    height: Math.max(
      MIN_EXTENT,
      (Number.isFinite(size.height) ? size.height : 0) - safePadding * 2,
    ),
  }

  if (boxes.length === 0) return { scale: 1, originX: -safePadding, originY: -safePadding }

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
  // A box with finite fields can still have a non-finite EDGE (x + width can
  // overflow), and two boxes near opposite limits make the span itself
  // infinite. Either would drive `scale` to 0 and make `unprojectPoint`
  // divide by zero, so the span — not just the input — has to be checked.
  const spanX = finiteSpan(maxX - minX)
  const spanY = finiteSpan(maxY - minY)

  const scale = Math.min(1, drawable.width / spanX, drawable.height / spanY)
  // Centre the leftover slack, so a canvas that is wide-but-short sits in the
  // middle of the box rather than pinned to a corner.
  const slackX = (drawable.width - spanX * scale) / 2
  const slackY = (drawable.height - spanY * scale) / 2
  return {
    scale,
    originX: minX - (safePadding + slackX) / scale,
    originY: minY - (safePadding + slackY) / scale,
  }
}

/** Projects a canvas-space box into minimap space. */
export function projectBox(box: MinimapBox, fit: MinimapFit): MinimapBox {
  return {
    x: (box.x - fit.originX) * fit.scale,
    y: (box.y - fit.originY) * fit.scale,
    width: box.width * fit.scale,
    height: box.height * fit.scale,
  }
}

/**
 * The largest `limit` rects by area, fitted together into a `size` box — what
 * an icon-sized overview wants, where anything smaller is noise. Each answer
 * keeps its source so the caller can carry what the geometry does not know
 * (a colour) and apply its own minimum extent and offset.
 *
 * The viewport that `fitMinimap` also fits is the first kept rect: an icon
 * has none, and `fitMinimap` never widens the bounds past the content, so
 * the stand-in changes nothing.
 */
export function fitLargestRects<T extends { x: number; y: number; w: number; h: number }>(
  rects: readonly T[],
  limit: number,
  size: { readonly width: number; readonly height: number },
): { source: T; box: MinimapBox }[] {
  const kept = [...rects].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, limit)
  const boxes = kept.map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }))
  const [first] = boxes
  if (first === undefined) return []
  const fit = fitMinimap(boxes, first, size, 0)
  return kept.map((source, i) => ({
    source,
    box: projectBox(boxes[i] as MinimapBox, fit),
  }))
}

/** The canvas-space point under a minimap-space point — for click-to-navigate. */
export function unprojectPoint(
  point: { readonly x: number; readonly y: number },
  fit: MinimapFit,
): { x: number; y: number } {
  return { x: point.x / fit.scale + fit.originX, y: point.y / fit.scale + fit.originY }
}

/** An authored colour as the accent the scene draws it in: a hex as itself, a preset by the palette. */
function accentOf(color: string | undefined, palette: SpatialPalette): string | undefined {
  if (color === undefined) return undefined
  if (color.startsWith('#')) return color
  return palette.presets[color as SpatialPresetKey]?.stroke
}

/**
 * Node boxes for the minimap overview, with each authored colour resolved to
 * the accent the scene already uses for it. A preset key resolves through
 * the given palette; a hex passes through; an unstyled node carries no
 * colour and the overview falls back to its muted default. A node whose tag
 * the workspace's library colours is drawn in that colour — the board's own
 * colour by intent, which the layout applies to the canvas and the overview
 * reads from the nodes.
 *
 * Looks up each box's node by id via a `Map` built once, rather than
 * `nodes.find` per box (O(n) per lookup, O(n^2) over the whole canvas) —
 * `find`-first and `Map`-last-wins cannot diverge for valid input, since
 * node id uniqueness is a schema invariant (spatial.ts's `superRefine`
 * rejects a duplicate node id before a canvas is ever constructed).
 */
function buildMinimapNodes(
  nodes: SpatialCanvas['nodes'],
  boxes: readonly NodeBox[],
  palette: SpatialPalette,
  tagLibrary?: TagLibrary,
): readonly (MinimapBox & { readonly color?: string; readonly symbol?: VisualSymbolFacet })[] {
  const drawn = withDeclaredColours({ nodes: [...nodes], edges: [] }, tagLibrary).nodes
  const byId = new Map(drawn.map((node) => [node.id, node]))
  const colorOf = (id: string): string | undefined => accentOf(byId.get(id)?.color, palette)
  // Resolved HERE, beside the colour, for the same reason the colour is: the
  // overview component knows nothing about palettes or facets, and an
  // overview is exactly where a node is too small to read — which is what
  // `visual.symbol` was built for.
  return boxes.map((entry) => {
    const node = byId.get(entry.id)
    const symbol = node === undefined ? undefined : resolveNodeSymbol(node)
    return {
      ...entry.box,
      color: colorOf(entry.id),
      ...(symbol === undefined ? {} : { symbol }),
    }
  })
}

/** A drawn line in the overview: the points it passes through, in canvas space. */
export interface MinimapStroke {
  readonly points: readonly { readonly x: number; readonly y: number }[]
  readonly color?: string
}

/**
 * Lines with at least one free end — ink, which is what the pen draws — as
 * polylines for the overview. A line tied to nodes at BOTH ends is a
 * connector between boxes the overview already shows; ink is often the only
 * content a board has, and an overview that drew boxes alone showed such a
 * board as empty.
 *
 * An end on a node stands at that node's centre: at overview scale a box is
 * a few pixels, so the side it leaves from is below what the eye resolves.
 * An end whose node has no box (a dangling reference) drops the line rather
 * than inventing a position for it.
 */
function buildMinimapStrokes(
  lines: SpatialCanvas['lines'],
  boxes: readonly NodeBox[],
  palette: SpatialPalette,
): readonly MinimapStroke[] {
  const boxOf = new Map(boxes.map((entry) => [entry.id, entry.box]))
  const at = (end: LineEnd): { x: number; y: number } | undefined => {
    if (end.kind === 'point') return end.point
    const box = boxOf.get(end.node)
    return box === undefined ? undefined : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  return (lines ?? []).flatMap((line) => {
    if (endNode(line.from) !== undefined && endNode(line.to) !== undefined) return []
    const from = at(line.from)
    const to = at(line.to)
    if (from === undefined || to === undefined) return []
    const color = accentOf(line.color, palette)
    return [
      { points: [from, ...(line.bends ?? []), to], ...(color === undefined ? {} : { color }) },
    ]
  })
}

/** The canvas-space box a stroke covers, so the overview's fit includes it. */
export function strokeBounds(stroke: MinimapStroke): MinimapBox {
  const xs = stroke.points.map((p) => p.x)
  const ys = stroke.points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/**
 * The stroke's straight runs in minimap space, each as where it starts, how
 * long it is and which way it points — what a rotated hairline needs.
 *
 * Thinned at the overview's own scale first: a stroke stores up to
 * `MAX_BENDS` samples, and at a few pixels across most of them sit closer
 * together than a hairline is wide, each of which would otherwise be an
 * element. The last point is always kept, so the stroke still ends where it
 * ends.
 */
export function projectStrokeSegments(
  stroke: MinimapStroke,
  fit: MinimapFit,
): { readonly x: number; readonly y: number; readonly length: number; readonly angle: number }[] {
  const projected = stroke.points.map((p) => ({
    x: (p.x - fit.originX) * fit.scale,
    y: (p.y - fit.originY) * fit.scale,
  }))
  const kept: { x: number; y: number }[] = []
  for (const [i, point] of projected.entries()) {
    const last = kept[kept.length - 1]
    const far =
      last === undefined || Math.hypot(point.x - last.x, point.y - last.y) >= MINIMAP_STROKE_STEP_PX
    if (far || i === projected.length - 1) kept.push(point)
  }
  return kept.slice(1).map((b, i) => {
    const a = kept[i] as { x: number; y: number }
    return {
      x: a.x,
      y: a.y,
      length: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    }
  })
}

/** The shortest run, in overview pixels, worth an element of its own. */
const MINIMAP_STROKE_STEP_PX = 2

/**
 * Everything the overview draws, colour resolved: the node boxes and the ink.
 * One builder, so the overview's two layers are derived from one canvas in
 * one place rather than threaded through the editor separately.
 */
export function buildMinimap(
  canvas: SpatialCanvas,
  boxes: readonly NodeBox[],
  palette: SpatialPalette,
  tagLibrary?: TagLibrary,
): {
  readonly boxes: ReturnType<typeof buildMinimapNodes>
  readonly strokes: readonly MinimapStroke[]
} {
  return {
    boxes: buildMinimapNodes(canvas.nodes, boxes, palette, tagLibrary),
    strokes: buildMinimapStrokes(canvas.lines, boxes, palette),
  }
}
