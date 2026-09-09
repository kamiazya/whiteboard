import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { sceneBounds } from '../scene-bounds.js'
import type { BoundingBox, ResolvedEdgeNode, Scene, TextRunNode } from '../scene-graph.js'

/**
 * How well a drawing reads, as numbers a person can check against the
 * picture. The other instruments in this package each judge one mechanism
 * — the router, tidy, bubble placement — on the terms of that mechanism;
 * this one judges the BOARD, whoever drew it: a model through the tool
 * surface, a person in the editor, or tidy over either. It is what turns
 * "can a model draw an architecture diagram" from a verdict on the store
 * into a distance from a drawing someone would put in a report.
 *
 * Read from geometry only. The layout's own scorers (`edge-rules.ts`'s
 * penalties, tidy's overlap test) are never consulted, so a rule that is
 * wrong cannot pass by agreeing with itself; and the routing scoreboard's
 * oracle in `test-utils/routing-metrics.ts` is deliberately not imported
 * either — it is that scoreboard's independent witness, and a production
 * module reaching into it would make the two share a defect.
 *
 * DEBT metrics target zero and each names a thing a reader would call a
 * mistake. PRICE metrics have no target: an edge that goes around a box
 * costs bends, and a board that keeps its labels clear costs envelope. They
 * are here so a change that buys less of one harm with more of another has
 * to say so.
 */
export interface DrawingScore {
  /** Denominators: what the board holds, containers included. */
  readonly nodes: number
  readonly edges: number

  // ── DEBT ───────────────────────────────────────────────────────────────
  /** Pairs of non-container boxes that overlap. */
  readonly nodeOverlaps: number
  /** Their overlapping area, summed. */
  readonly overlapAreaPx: number
  /** (box, container) pairs where the box is partly in and partly out. */
  readonly straddles: number
  /** (edge, box) pairs where the edge's ink runs INSIDE a box it does not connect. */
  readonly edgeThroughNode: number
  /** That ink, in px. */
  readonly throughInkPx: number
  /** Edge labels drawn over a box. */
  readonly labelOverNode: number
  /** Pairs of edge labels drawn over each other. */
  readonly labelOverLabel: number
  /** Container names (drawn above the frame) hidden under some other box. */
  readonly labelCovered: number
  /** Boxes whose content was cut or does not fit. */
  readonly textOverflow: number
  /** Members closer than `GROUP_PADDING_PX` to their innermost frame. */
  readonly crampedMembers: number
  /**
   * Pairs of boxes whose left edges, or top edges, differ by less than
   * `NEAR_MISS_PX` but not by zero: aligned in intent, not in fact.
   */
  readonly nearMisses: number

  // ── PRICE ──────────────────────────────────────────────────────────────
  /** Places two edges visibly cross. */
  readonly crossings: number
  /** Corners along every edge. */
  readonly bends: number
  /** Ink drawn for every edge, in px. */
  readonly edgeLengthPx: number
  /** Adjacent gaps in one row or column that differ by more than a grid step. */
  readonly unevenGaps: number
  /** The drawing's extent. */
  readonly envelopePx: { readonly w: number; readonly h: number }
  /** Box area over envelope area, two decimals; how much of the picture is content. */
  readonly density: number
}

/**
 * The band tidy snaps within: two edges closer than this were meant to
 * line up, so a difference under it reads as a mistake rather than a choice.
 */
export const NEAR_MISS_PX = 24
/** The least a member should keep from its frame before it reads as cramped. */
export const GROUP_PADDING_PX = 16
/** One grid step; two gaps within it read as equal. */
export const EVEN_GAP_TOLERANCE_PX = 8

type Rect = BoundingBox
type Point = { readonly x: number; readonly y: number }

const rectOf = (n: SpatialNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height })
const area = (r: Rect) => r.w * r.h
const overlapArea = (a: Rect, b: Rect): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h
const strictlyInside = (r: Rect, p: Point): boolean =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
const segmentLength = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)

/** Parameters of the part of `a`→`b` strictly inside `rect`, if any (Liang–Barsky). */
function clipOpen(a: Point, b: Point, rect: Rect): [number, number] | undefined {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const slabs: readonly [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y],
  ]
  for (const [p, q] of slabs) {
    if (p === 0) {
      // Parallel to this slab: on the boundary is border ink, not interior.
      if (q <= 0) return undefined
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return undefined
      if (t > t0) t0 = t
    } else {
      if (t < t0) return undefined
      if (t < t1) t1 = t
    }
  }
  return t1 > t0 ? [t0, t1] : undefined
}

function interiorInk(path: readonly Point[], rect: Rect): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const clip = clipOpen(a, b, rect)
    if (clip !== undefined) total += (clip[1] - clip[0]) * segmentLength(a, b)
  }
  return total
}

function bendsOf(path: readonly Point[]): number {
  let count = 0
  for (let i = 2; i < path.length; i++) {
    const a = path[i - 2] as Point
    const b = path[i - 1] as Point
    const c = path[i] as Point
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) count++
  }
  return count
}

function lengthOf(path: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++)
    total += segmentLength(path[i - 1] as Point, path[i] as Point)
  return total
}

/** True when the two segments meet at a point interior to both. */
function properlyCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  const d1 = orient(a, b, c)
  const d2 = orient(a, b, d)
  const d3 = orient(c, d, a)
  const d4 = orient(c, d, b)
  // All four strict: touching at an endpoint is not a crossing, and collinear
  // overlap is a different defect.
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4
}

function crossingsOf(paths: readonly (readonly Point[])[]): number {
  let count = 0
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const p = paths[i] as readonly Point[]
      const q = paths[j] as readonly Point[]
      for (let a = 1; a < p.length; a++) {
        for (let b = 1; b < q.length; b++) {
          if (properlyCross(p[a - 1] as Point, p[a] as Point, q[b - 1] as Point, q[b] as Point))
            count++
        }
      }
    }
  }
  return count
}

/** Pairs across `items`, each once. */
function pairs<T>(items: readonly T[], visit: (a: T, b: T) => void): void {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) visit(items[i] as T, items[j] as T)
  }
}

/**
 * Rows (by top) or columns (by left): greedy bands of `NEAR_MISS_PX`
 * anchored on the first member, in the order tidy would band them. Within
 * a band the members are ordered along the other axis, and the gaps
 * between neighbours are what evenness is judged on.
 */
function unevenGapsAlong(
  boxes: readonly Rect[],
  band: (r: Rect) => number,
  start: (r: Rect) => number,
  extent: (r: Rect) => number,
): number {
  const sorted = [...boxes].sort((a, b) => band(a) - band(b))
  const bands: Rect[][] = []
  for (const r of sorted) {
    const current = bands[bands.length - 1]
    const anchor = current?.[0]
    if (current !== undefined && anchor !== undefined && band(r) - band(anchor) < NEAR_MISS_PX) {
      current.push(r)
    } else {
      bands.push([r])
    }
  }
  let uneven = 0
  for (const members of bands) {
    const along = [...members].sort((a, b) => start(a) - start(b))
    const gaps: number[] = []
    for (let i = 1; i < along.length; i++) {
      const prev = along[i - 1] as Rect
      const next = along[i] as Rect
      gaps.push(start(next) - (start(prev) + extent(prev)))
    }
    for (let i = 1; i < gaps.length; i++) {
      if (Math.abs((gaps[i] as number) - (gaps[i - 1] as number)) > EVEN_GAP_TOLERANCE_PX) uneven++
    }
  }
  return uneven
}

const isEdge = (n: Scene['nodes'][number]): n is ResolvedEdgeNode => n.kind === 'edge'
const isRun = (n: Scene['nodes'][number]): n is TextRunNode => n.kind === 'textRun'

export function scoreDrawing(canvas: SpatialCanvas, scene: Scene): DrawingScore {
  const nodes = canvas.nodes
  const groups = nodes.filter((n) => n.type === 'group')
  const boxes = nodes.filter((n) => n.type !== 'group')
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  const edgeById = new Map<string, CanvasEdge>(canvas.edges.map((e) => [e.id, e] as const))

  let nodeOverlaps = 0
  let overlapAreaPx = 0
  pairs(boxes, (a, b) => {
    const shared = overlapArea(rectOf(a), rectOf(b))
    if (shared > 0) {
      nodeOverlaps++
      overlapAreaPx += shared
    }
  })

  // A box partly in and partly out of a frame, and two frames that
  // overlap without one holding the other. Each unordered pair once.
  let straddles = 0
  pairs(nodes, (a, b) => {
    if (a.type !== 'group' && b.type !== 'group') return
    const ra = rectOf(a)
    const rb = rectOf(b)
    if (overlapArea(ra, rb) > 0 && !contains(ra, rb) && !contains(rb, ra)) straddles++
  })

  // Edges the canvas owns, by id; chrome edges (a comment's leader) are not
  // the drawing's. A frame is never "through": an edge between two members
  // legitimately runs inside it. An edge's OWN endpoint boxes are not
  // exempt — only a box that strictly contains an anchor is, since no
  // detour can avoid the point inside it. An edge that leaves its source
  // and comes back through it is the picture the first live reading
  // showed, and a reader calls it wrong before anything else on the board.
  const edges = scene.nodes
    .filter(isEdge)
    .map((e) => ({ edge: edgeById.get(e.id), path: e.path }))
    .filter((e): e is { edge: CanvasEdge; path: readonly Point[] } => e.edge !== undefined)
  let edgeThroughNode = 0
  let throughInkPx = 0
  for (const { path } of edges) {
    for (const box of boxes) {
      const rect = rectOf(box)
      const start = path[0]
      const end = path[path.length - 1]
      if (start !== undefined && strictlyInside(rect, start)) continue
      if (end !== undefined && strictlyInside(rect, end)) continue
      const ink = interiorInk(path, rect)
      if (ink > 0) {
        edgeThroughNode++
        throughInkPx += ink
      }
    }
  }
  const paths = edges.map((e) => e.path)

  const runs = scene.nodes.filter(isRun)
  const edgeLabels = runs.filter((r) => r.annotates?.kind === 'edge')
  let labelOverNode = 0
  for (const label of edgeLabels) {
    for (const box of boxes) if (overlapArea(label.bbox, rectOf(box)) > 0) labelOverNode++
  }
  let labelOverLabel = 0
  pairs(edgeLabels, (a, b) => {
    if (overlapArea(a.bbox, b.bbox) > 0) labelOverLabel++
  })
  let labelCovered = 0
  for (const label of runs) {
    if (label.annotates?.kind !== 'node') continue
    const own = label.annotates.id
    if (nodes.some((n) => n.id !== own && overlapArea(label.bbox, rectOf(n)) > 0)) labelCovered++
  }

  let textOverflow = 0
  for (const n of scene.nodes) {
    if (n.kind !== 'shape' || n.id === undefined || !byId.has(n.id)) continue
    if (n.commentChrome === true || n.proposalChrome !== undefined) continue
    if (n.truncated === true || n.overflows === true) textOverflow++
  }

  // A member is judged against the innermost frame holding it, so a box
  // deep in a nested layout is not charged the outer frame's padding.
  let crampedMembers = 0
  for (const n of nodes) {
    const r = rectOf(n)
    const frames = groups.filter((g) => g.id !== n.id && contains(rectOf(g), r))
    if (frames.length === 0) continue
    const inner = frames.reduce((best, g) => (area(rectOf(g)) < area(rectOf(best)) ? g : best))
    const f = rectOf(inner)
    const clearance = Math.min(
      r.x - f.x,
      r.y - f.y,
      f.x + f.w - (r.x + r.w),
      f.y + f.h - (r.y + r.h),
    )
    if (clearance < GROUP_PADDING_PX) crampedMembers++
  }

  // Container and member line up by padding, not by intent, so a pair where
  // one holds the other is not asked to align.
  let nearMisses = 0
  pairs(nodes, (a, b) => {
    const ra = rectOf(a)
    const rb = rectOf(b)
    if (contains(ra, rb) || contains(rb, ra)) return
    const dx = Math.abs(ra.x - rb.x)
    const dy = Math.abs(ra.y - rb.y)
    if (dx > 0 && dx < NEAR_MISS_PX) nearMisses++
    if (dy > 0 && dy < NEAR_MISS_PX) nearMisses++
  })

  const boxRects = boxes.map(rectOf)
  const unevenGaps =
    unevenGapsAlong(
      boxRects,
      (r) => r.y,
      (r) => r.x,
      (r) => r.w,
    ) +
    unevenGapsAlong(
      boxRects,
      (r) => r.x,
      (r) => r.y,
      (r) => r.h,
    )

  const envelope = scene.nodes.length === 0 ? { x: 0, y: 0, w: 0, h: 0 } : sceneBounds(scene)
  const envelopeArea = envelope.w * envelope.h
  const boxArea = boxRects.reduce((sum, r) => sum + area(r), 0)

  return {
    nodes: nodes.length,
    edges: canvas.edges.length,
    nodeOverlaps,
    overlapAreaPx: Math.round(overlapAreaPx),
    straddles,
    edgeThroughNode,
    throughInkPx: Math.round(throughInkPx),
    labelOverNode,
    labelOverLabel,
    labelCovered,
    textOverflow,
    crampedMembers,
    nearMisses,
    crossings: crossingsOf(paths),
    bends: paths.reduce((sum, p) => sum + bendsOf(p), 0),
    edgeLengthPx: Math.round(paths.reduce((sum, p) => sum + lengthOf(p), 0)),
    unevenGaps,
    envelopePx: { w: Math.round(envelope.w), h: Math.round(envelope.h) },
    density: envelopeArea === 0 ? 0 : Math.round((boxArea / envelopeArea) * 100) / 100,
  }
}
