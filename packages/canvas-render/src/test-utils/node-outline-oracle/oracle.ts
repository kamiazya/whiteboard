import type { BoundingBox, NodeOutline } from '@kamiazya/whiteboard-scene'
import { nodeOutline, outlineContains, outlineEntryPoint } from '../../layout/nodes/node-outline.js'
import { f64Hex } from '../render-oracle/scene-dump.js'

/**
 * The recorded answers of a silhouette's hit test and edge anchoring
 * (`outlineContains`, `outlineEntryPoint` in `layout/nodes/node-outline.ts`),
 * for every bundled silhouette, an id no table carries, and boxes from the
 * ordinary to the degenerate and the non-finite.
 *
 * A `contains` record holds the points asked and one `0`/`1` per point. The
 * points are a grid over and around the box plus every point the outline's own
 * boundary is made of (vertices, edge midpoints, extremes, the cylinder's rim
 * heights), each also nudged a hair either way, because a boundary is where a
 * `<` and a `<=` part. An `entry` record holds approaches (`from`, `to`) and
 * where each lands. Every double is the hex of its IEEE bits, a NaN the
 * canonical one.
 */

type Point = { readonly x: number; readonly y: number }

/** `f64Hex`, with every NaN written as the positive quiet NaN `f64::NAN` is. */
const hex = (value: number): string => (Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value))
const pointHex = (p: Point): readonly string[] => [hex(p.x), hex(p.y)]
const boxHex = (b: BoundingBox): readonly string[] => [b.x, b.y, b.w, b.h].map(hex)

const SHAPES = [
  'visual.ellipse',
  'visual.diamond',
  'visual.hexagon',
  'visual.parallelogram',
  'visual.octagon',
  'visual.cylinder',
  'visual.nothing',
] as const

const BIG = 1e308

const BOXES: readonly BoundingBox[] = [
  { x: 0, y: 0, w: 160, h: 100 },
  { x: -30.5, y: 12.25, w: 40, h: 200 },
  { x: 10, y: 10, w: 300, h: 20 },
  { x: 7, y: -3, w: 100, h: 7 },
  { x: 5, y: 5, w: 0, h: 0 },
  { x: 5, y: 5, w: 0, h: 80 },
  { x: 5, y: 5, w: 80, h: 0 },
  { x: 0, y: 0, w: -60, h: 40 },
  { x: 0, y: 0, w: 60, h: -40 },
  { x: 3, y: 4, w: -60, h: -40 },
  { x: 0, y: Number.NaN, w: 60, h: 40 },
  { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 40 },
  { x: BIG, y: BIG, w: BIG, h: BIG },
]

/** The points the outline itself is drawn through, and its extremes. */
function outlinePoints(outline: NodeOutline | null): Point[] {
  if (outline === null) return []
  if (outline.kind === 'polygon') {
    const n = outline.points.length
    return outline.points.flatMap((p, i) => {
      const q = outline.points[(i + 1) % n]!
      return [p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }]
    })
  }
  if (outline.kind === 'ellipse') {
    const { cx, cy, rx, ry } = outline
    return [
      { x: cx - rx, y: cy },
      { x: cx + rx, y: cy },
      { x: cx, y: cy - ry },
      { x: cx, y: cy + ry },
      { x: cx + rx * 0.6, y: cy + ry * 0.8 },
    ]
  }
  const { x, y, w, h, ry } = outline
  const ys = [y, y + ry / 2, y + ry, y + h - ry, y + h - ry / 2, y + h]
  return ys.flatMap((at) => [x, x + w / 2, x + w, x + w * 0.1].map((px) => ({ x: px, y: at })))
}

/** A hair either way of `p` on each axis, and `p` itself. */
const nudged = (p: Point): Point[] => {
  const e = 1e-9 * Math.max(1, Math.abs(p.x), Math.abs(p.y))
  return [
    p,
    { x: p.x + e, y: p.y },
    { x: p.x - e, y: p.y },
    { x: p.x, y: p.y + e },
    { x: p.x, y: p.y - e },
  ]
}

/** A 7 by 7 grid from a quarter outside the box to a quarter past it. */
function grid(b: BoundingBox): Point[] {
  const span = (at: number, size: number) =>
    Array.from({ length: 7 }, (_, i) => at - size / 4 + (size * 1.5 * i) / 6)
  const xs = span(b.x, Number.isFinite(b.w) ? b.w : 100)
  const ys = span(b.y, Number.isFinite(b.h) ? b.h : 100)
  return xs.flatMap((x) => ys.map((y) => ({ x, y })))
}

function containsPoints(shape: string, b: BoundingBox): Point[] {
  const centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const corners = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x, y: b.y + b.h },
    { x: b.x + b.w, y: b.y + b.h },
  ]
  const special = [centre, ...corners, ...outlinePoints(nodeOutline(shape, b))].flatMap(nudged)
  const odd = [
    { x: Number.NaN, y: centre.y },
    { x: centre.x, y: Number.POSITIVE_INFINITY },
  ]
  return [...grid(b), ...special, ...odd]
}

/** Where a route might end on the box, and the points it might approach them from. */
function approaches(b: BoundingBox): (readonly [Point, Point])[] {
  const { x, y, w, h } = b
  const ends: Point[] = [
    { x: x + w / 2, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 },
    { x: x + w / 4, y },
    { x: x + w, y: y + h / 5 },
    { x: x + (w * 3) / 4, y: y + h },
    { x, y },
    { x: x + w, y: y + h },
    { x: x + w / 2, y: y + h / 2 },
  ]
  const offsets: Point[] = [
    { x: 0, y: -50 },
    { x: 50, y: 0 },
    { x: 0, y: 50 },
    { x: -50, y: 0 },
    { x: 37, y: -29 },
    { x: -13, y: 61 },
    { x: 0, y: 0 },
  ]
  const pairs = ends.flatMap((to) =>
    offsets.map((d) => [{ x: to.x + d.x, y: to.y + d.y }, to] as const),
  )
  const odd: (readonly [Point, Point])[] = [
    [
      { x: Number.NaN, y: 0 },
      { x, y },
    ],
    [
      { x: 0, y: 0 },
      { x: Number.POSITIVE_INFINITY, y },
    ],
    [
      { x: x - 1e6, y: y + h / 2 },
      { x: x - 1e6 + 1, y: y + h / 2 },
    ],
  ]
  return [...pairs, ...odd]
}

interface ContainsRecord {
  readonly kind: 'contains'
  readonly shape: string
  readonly box: readonly string[]
  readonly points: readonly (readonly string[])[]
  /** One `0` or `1` per point. */
  readonly inside: string
}

interface EntryRecord {
  readonly kind: 'entry'
  readonly shape: string
  readonly box: readonly string[]
  /** `from`, `to` and where the terminal lands, as four doubles each pair of two. */
  readonly approaches: readonly (readonly string[])[]
}

export type NodeOutlineRecord = ContainsRecord | EntryRecord

function containsRecord(shape: string, b: BoundingBox): ContainsRecord {
  const points = containsPoints(shape, b)
  return {
    kind: 'contains',
    shape,
    box: boxHex(b),
    points: points.map(pointHex),
    inside: points.map((p) => (outlineContains(shape, b, p) ? '1' : '0')).join(''),
  }
}

function entryRecord(shape: string, b: BoundingBox): EntryRecord {
  return {
    kind: 'entry',
    shape,
    box: boxHex(b),
    approaches: approaches(b).map(([from, to]) => [
      ...pointHex(from),
      ...pointHex(to),
      ...pointHex(outlineEntryPoint(shape, b, from, to)),
    ]),
  }
}

/** Every record, in file order: for each silhouette and box, its hit test then its anchoring. */
export function nodeOutlineRecords(): readonly NodeOutlineRecord[] {
  return SHAPES.flatMap((shape) =>
    BOXES.flatMap((b) => [containsRecord(shape, b), entryRecord(shape, b)]),
  )
}
