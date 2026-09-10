/**
 * The sketch ink decomposition (ADR-0030 decision 7, canvas-render decision
 * #10): ONE pure function per primitive from semantic geometry to the
 * strokes a hand would draw — consumed by the SVG backend and by nothing
 * that decides hit-testing or bounds, which keep reading the bbox and the
 * routed path. Ink is decoration; the box is the fact.
 *
 * Two contracts a consumer may rely on:
 *
 * - Every coordinate a stroke names lies within the primitive's own bounds
 *   plus `SKETCH_INK_REACH_PX`. The end points are displaced by at most
 *   `JITTER_PX` per axis, a closing corner overshoots by `OVERSHOOT_PX`
 *   along its side, and a quadratic's control point sits at most
 *   `BOW_MAX_PX` off its chord; a quadratic never leaves the triangle of
 *   its three points — so checking the named points checks the curve.
 *   `sceneBounds` widens an inked node by exactly this constant.
 * - The randomness is `styleRandomFromSeed(seed)` and nothing else, consumed
 *   in one fixed order, with no positional input: the same seed on a moved
 *   box draws the same ink moved (pinned by property), and a canvas renders
 *   byte-identically twice.
 *
 * Two passes per outline, slightly different, is what reads as pencil
 * rather than a shaky single line — the same choice rough.js and tldraw
 * arrived at. Each pass is ONE continuous sub-path: its vertices are
 * displaced once and shared by the sides that meet there, so a corner is
 * a join rather than a gap between two independently shaken ends, and a
 * closed outline runs a little past its start the way a pen does. The bow
 * of a side grows with its length (rough.js's rule) — an absolute amplitude
 * left a 600px frame as straight as a ruler while a 60px chip wobbled.
 */
import type { ArrowPolygon } from '../../edge-arrows.js'
import type { BoundingBox, EdgeJumpPoint } from '../../scene-graph.js'
import { flattenDrawnEdgePath } from '../edges/edge-flatten.js'
import type { NodeOutline } from '../nodes/node-outline.js'
import { styleRandomFromSeed } from '../seed.js'

/** How far (px) sketch ink may leave the semantic geometry it draws. */
export const SKETCH_INK_REACH_PX = 8
/** End-point displacement per axis, ±. */
const JITTER_PX = 1.2
/** Control-point offset off the chord, ±, per px of segment length. */
const BOW_PER_PX = 0.012
/** The bow's ceiling, so a wall-sized frame does not sag into its members. */
const BOW_MAX_PX = 6
/** How far a closed outline runs past its start along the last side. */
const OVERSHOOT_PX = 3
/** Outline and edge passes; the strokes a consumer sees first are these, in order. */
export const SKETCH_PASSES = 2
/** Points per half-ellipse arc. */
const ARC_SAMPLES = 12
/** Points around a whole ellipse. */
const ELLIPSE_SAMPLES = 24
/**
 * A curve is inked from sampled chords whose control point sits on the TRUE
 * arc, so the quadratic follows the rim instead of scalloping between
 * vertices; the hand's unsteadiness is then a small offset on top. Measured
 * before this: per-vertex jitter on a 24-sample ellipse read as tick marks.
 */
const CURVE_JITTER_PX = 0.7
const CURVE_BOW_PX = 0.8
/** Along an edge, ink is re-anchored this often; between anchors it bows. */
const EDGE_STEP_PX = 24
const HATCH_GAP_PX = 6
const HATCH_ANGLE = (-41 * Math.PI) / 180
/** Hatch lines are lighter than the outline and barely displaced. */
const HATCH_JITTER_PX = 0.5
const HATCH_BOW_PX = 0.6

type Point = { readonly x: number; readonly y: number }
type Rng = () => number

export interface SketchInk {
  /** Outline strokes, one path per pass (plus the lid passes of a cylinder). */
  readonly strokes: readonly string[]
  /** Hatch fill lines, present only when asked for and the shape has an area. */
  readonly hatch?: readonly string[]
}

const num = (value: number): string => {
  const rounded = Math.round(value * 100) / 100
  return String(rounded === 0 ? 0 : rounded)
}

const isFiniteBox = (box: BoundingBox): boolean =>
  Number.isFinite(box.x) &&
  Number.isFinite(box.y) &&
  Number.isFinite(box.w) &&
  Number.isFinite(box.h)

/** One jittered stroke from `a` to `b`: displaced ends, a bowed quadratic between. */
function jittered(rng: Rng, a: Point, b: Point, jitter: number, bow: number): string {
  const j = (): number => (rng() * 2 - 1) * jitter
  const ax = a.x + j()
  const ay = a.y + j()
  const bx = b.x + j()
  const by = b.y + j()
  const [cx, cy] = bowed(rng, a, b, bow)
  return `M ${num(ax)} ${num(ay)} Q ${num(cx)} ${num(cy)} ${num(bx)} ${num(by)}`
}

/** The control point of a bowed quadratic over the chord `a`→`b`: at most `bow` off it. */
function bowed(rng: Rng, a: Point, b: Point, bow: number): readonly [number, number] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const t = 0.35 + rng() * 0.3
  const off = (rng() * 2 - 1) * bow
  const nx = len === 0 ? 0 : -dy / len
  const ny = len === 0 ? 0 : dx / len
  return [a.x + dx * t + nx * off, a.y + dy * t + ny * off]
}

/** A side's bow amplitude: proportional to its length, capped. */
const sideBow = (a: Point, b: Point): number =>
  Math.min(BOW_MAX_PX, Math.hypot(b.x - a.x, b.y - a.y) * BOW_PER_PX)

/** One displaced copy of each vertex, shared by the segments meeting there. */
function shaken(rng: Rng, points: readonly Point[], amount: number): Point[] {
  return points.map((p) => ({
    x: p.x + (rng() * 2 - 1) * amount,
    y: p.y + (rng() * 2 - 1) * amount,
  }))
}

/**
 * One chord of a curve, from its already-displaced ends, with the control
 * point at the quadratic that passes through the arc's true midpoint
 * (`2·mid − (a+b)/2`), nudged. The control point sits outside the rim by
 * the chord's sagitta, which at 15° steps on the largest box this package
 * lays out is under 2px — inside the declared reach with the nudge.
 */
function curvedTo(rng: Rng, a: Point, b: Point, mid: Point, to: Point): string {
  const j = (amount: number): number => (rng() * 2 - 1) * amount
  const cx = 2 * mid.x - (a.x + b.x) / 2 + j(CURVE_BOW_PX)
  const cy = 2 * mid.y - (a.y + b.y) / 2 + j(CURVE_BOW_PX)
  return `Q ${num(cx)} ${num(cy)} ${num(to.x)} ${num(to.y)}`
}

/**
 * A straight-sided polyline (closed when `close`) as ONE continuous path:
 * the vertices displaced once, a bowed quadratic per side between them,
 * and — closed — a last side that runs `OVERSHOOT_PX` past the start.
 */
function strokePolyline(rng: Rng, points: readonly Point[], close: boolean): string {
  const n = points.length
  if (n === 0) return ''
  const shook = shaken(rng, points, JITTER_PX)
  const parts = [`M ${num(shook[0]!.x)} ${num(shook[0]!.y)}`]
  const sides = close ? n : n - 1
  for (let i = 0; i < sides; i += 1) {
    const a = points[i]!
    const b = points[(i + 1) % n]!
    const [cx, cy] = bowed(rng, a, b, sideBow(a, b))
    let to = shook[(i + 1) % n]!
    if (close && i === sides - 1) {
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len > 0) {
        to = {
          x: to.x + ((b.x - a.x) / len) * OVERSHOOT_PX,
          y: to.y + ((b.y - a.y) / len) * OVERSHOOT_PX,
        }
      }
    }
    parts.push(`Q ${num(cx)} ${num(cy)} ${num(to.x)} ${num(to.y)}`)
  }
  return parts.join(' ')
}

/** A sampled curve — vertices with the true midpoint of each chord — as one path. */
interface Curve {
  readonly points: readonly Point[]
  readonly mids: readonly Point[]
  readonly closed: boolean
}

function strokeCurve(rng: Rng, curve: Curve): string {
  const n = curve.points.length
  if (n === 0) return ''
  const shook = shaken(rng, curve.points, CURVE_JITTER_PX)
  const parts = [`M ${num(shook[0]!.x)} ${num(shook[0]!.y)}`]
  const chords = curve.closed ? n : n - 1
  for (let i = 0; i < chords; i += 1) {
    const next = (i + 1) % n
    parts.push(curvedTo(rng, curve.points[i]!, curve.points[next]!, curve.mids[i]!, shook[next]!))
  }
  return parts.join(' ')
}

const onEllipse = (cx: number, cy: number, rx: number, ry: number, a: number): Point => ({
  x: cx + rx * Math.cos(a),
  y: cy + ry * Math.sin(a),
})

function ellipseCurve(cx: number, cy: number, rx: number, ry: number): Curve {
  const points: Point[] = []
  const mids: Point[] = []
  const step = (Math.PI * 2) / ELLIPSE_SAMPLES
  for (let i = 0; i < ELLIPSE_SAMPLES; i += 1) {
    points.push(onEllipse(cx, cy, rx, ry, i * step))
    mids.push(onEllipse(cx, cy, rx, ry, (i + 0.5) * step))
  }
  return { points, mids, closed: true }
}

/** A half-ellipse from angle `from` to `to`, inclusive of both ends. */
function arcCurve(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Curve {
  const points: Point[] = []
  const mids: Point[] = []
  const step = (to - from) / ARC_SAMPLES
  for (let i = 0; i <= ARC_SAMPLES; i += 1) {
    points.push(onEllipse(cx, cy, rx, ry, from + step * i))
    if (i < ARC_SAMPLES) mids.push(onEllipse(cx, cy, rx, ry, from + step * (i + 0.5)))
  }
  return { points, mids, closed: false }
}

/**
 * The closed polyline the outline is inked along, plus any open extra
 * strokes (the cylinder's lid). Rect corners ignore the radius: a hand
 * does not draw a 6px fillet.
 */
/**
 * What one outline is inked as: straight-sided polylines (a rect, a
 * polygon), curves (an ellipse; a cylinder's two caps and lid, joined to
 * its straight sides), and the polygon a hatch is clipped to.
 */
interface Silhouette {
  /** Strokes, in drawing order; each is straight-sided or a sampled curve. */
  readonly strokes: readonly (readonly Point[] | Curve)[]
  /** The convex region a hatch fills. */
  readonly region: readonly Point[]
}

const isCurve = (stroke: readonly Point[] | Curve): stroke is Curve => 'mids' in stroke

function silhouetteOf(outline: NodeOutline | null, box: BoundingBox): Silhouette {
  if (outline === null) {
    const corners = [
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h },
      { x: box.x, y: box.y + box.h },
    ]
    return { strokes: [corners], region: corners }
  }
  switch (outline.kind) {
    case 'polygon':
      return { strokes: [outline.points], region: outline.points }
    case 'ellipse': {
      const curve = ellipseCurve(outline.cx, outline.cy, outline.rx, outline.ry)
      return { strokes: [curve], region: curve.points }
    }
    case 'cylinder': {
      const { x, y, w, h, ry } = outline
      const rx = w / 2
      const cx = x + rx
      const top = y + ry
      const bottom = y + h - ry
      // Over the top cap, down the right side, under the bottom cap, up the
      // left side — the same silhouette the crisp path draws — then the lid:
      // the visible lower half of the top cap, left to right.
      const over = arcCurve(cx, top, rx, ry, Math.PI, 2 * Math.PI)
      const under = arcCurve(cx, bottom, rx, ry, 0, Math.PI)
      const lid = arcCurve(cx, top, rx, ry, Math.PI, 0)
      const right = [
        { x: x + w, y: top },
        { x: x + w, y: bottom },
      ]
      const left = [
        { x, y: bottom },
        { x, y: top },
      ]
      return {
        strokes: [over, right, under, left, lid],
        region: [...over.points, ...under.points],
      }
    }
  }
}

/**
 * Clip the infinite line through `origin` along `dir` to a convex polygon
 * (Cyrus-Beck). Outlines are convex by contract (node-outline.ts), so one
 * entry and one exit is all there is. `undefined` when the line misses.
 */
function clipToConvex(
  origin: Point,
  dir: Point,
  polygon: readonly Point[],
): { readonly from: Point; readonly to: Point } | undefined {
  let area = 0
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    area += a.x * b.y - b.x * a.y
  }
  const inwardSign = area >= 0 ? 1 : -1
  let tEnter = Number.NEGATIVE_INFINITY
  let tExit = Number.POSITIVE_INFINITY
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    const ex = b.x - a.x
    const ey = b.y - a.y
    // Inward normal of the edge for this winding.
    const nx = -ey * inwardSign
    const ny = ex * inwardSign
    const numerator = (origin.x - a.x) * nx + (origin.y - a.y) * ny
    const denominator = dir.x * nx + dir.y * ny
    if (denominator === 0) {
      if (numerator < 0) return undefined
      continue
    }
    const t = -numerator / denominator
    if (denominator > 0) tEnter = Math.max(tEnter, t)
    else tExit = Math.min(tExit, t)
    if (tEnter > tExit) return undefined
  }
  if (!Number.isFinite(tEnter) || !Number.isFinite(tExit) || tExit - tEnter < 1) return undefined
  return {
    from: { x: origin.x + dir.x * tEnter, y: origin.y + dir.y * tEnter },
    to: { x: origin.x + dir.x * tExit, y: origin.y + dir.y * tExit },
  }
}

function hatchLines(rng: Rng, polygon: readonly Point[], box: BoundingBox): string[] {
  const dir = { x: Math.cos(HATCH_ANGLE), y: Math.sin(HATCH_ANGLE) }
  const normal = { x: -dir.y, y: dir.x }
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const reach = Math.hypot(box.w, box.h) / 2
  const lines: string[] = []
  for (let offset = -reach; offset <= reach; offset += HATCH_GAP_PX) {
    const origin = { x: cx + normal.x * offset, y: cy + normal.y * offset }
    const clipped = clipToConvex(origin, dir, polygon)
    if (clipped === undefined) continue
    lines.push(jittered(rng, clipped.from, clipped.to, HATCH_JITTER_PX, HATCH_BOW_PX))
  }
  return lines
}

/**
 * The ink of one node's chrome: `outline` as `nodeOutline` resolved it (null
 * for the rect), `box` its bbox, `seed` from the node's id. `hatch` asks for
 * a hatched fill — what a preset-coloured node gets instead of a flat tint.
 */
export function sketchShape(
  outline: NodeOutline | null,
  box: BoundingBox,
  seed: number,
  options: { readonly hatch?: boolean } = {},
): SketchInk {
  if (!isFiniteBox(box) || box.w <= 0 || box.h <= 0) return { strokes: [] }
  const rng = styleRandomFromSeed(seed)
  const silhouette = silhouetteOf(outline, box)
  const strokes: string[] = []
  // Every pass draws the whole silhouette as ONE path, so a rect is two
  // strokes and a cylinder — caps, sides and lid — is two as well; the
  // passes are what read as pencil, not the count of parts.
  for (let pass = 0; pass < SKETCH_PASSES; pass += 1) {
    strokes.push(
      silhouette.strokes
        .map((stroke) =>
          isCurve(stroke)
            ? strokeCurve(rng, stroke)
            : strokePolyline(rng, stroke, stroke === silhouette.region),
        )
        .join(' '),
    )
  }
  if (options.hatch !== true) return { strokes }
  return { strokes, hatch: hatchLines(rng, silhouette.region, box) }
}

/** Keep a point every `EDGE_STEP_PX` along the polyline, plus its last point. */
function resample(points: readonly Point[]): Point[] {
  const kept: Point[] = []
  let last: Point | undefined
  for (const [index, p] of points.entries()) {
    const isLast = index === points.length - 1
    if (last === undefined || isLast || Math.hypot(p.x - last.x, p.y - last.y) >= EDGE_STEP_PX) {
      kept.push(p)
      last = p
    }
  }
  return kept
}

export interface SketchEdgeOptions {
  /** Arrowheads to ink as wing strokes, in place of markers. */
  readonly arrows: readonly ArrowPolygon[]
  readonly rounded?: boolean
  readonly jumps?: readonly EdgeJumpPoint[]
}

/**
 * The ink of one routed edge: the SAME drawn polyline the hit-test flattens
 * (`flattenDrawnEdgePath` — rounded corners and jump hops included), re-
 * anchored every `EDGE_STEP_PX` and drawn in two bowed passes, then each
 * arrowhead as two wing strokes from the tip.
 */
export function sketchEdge(
  path: readonly Point[],
  seed: number,
  options: SketchEdgeOptions,
): { readonly strokes: readonly string[] } {
  if (path.length < 2 || path.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return { strokes: [] }
  }
  const rng = styleRandomFromSeed(seed)
  const drawn = resample(flattenDrawnEdgePath(path, options.jumps ?? [], options.rounded === true))
  const strokes: string[] = []
  for (let pass = 0; pass < SKETCH_PASSES; pass += 1)
    strokes.push(strokePolyline(rng, drawn, false))
  for (const arrow of options.arrows) {
    const [tip, left, right] = arrow.points
    if (tip === undefined || left === undefined || right === undefined) continue
    strokes.push(jittered(rng, tip, left, JITTER_PX, HATCH_BOW_PX))
    strokes.push(jittered(rng, tip, right, JITTER_PX, HATCH_BOW_PX))
  }
  return { strokes }
}
