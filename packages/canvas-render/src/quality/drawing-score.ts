import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { sceneBounds } from '../scene-bounds.js'
import type { BoundingBox, ResolvedEdgeNode, Scene, TextRunNode } from '../scene-graph.js'
import {
  bends,
  crossings as crossingsOf,
  interiorInk,
  pathLength,
  reversals,
  sharedInk,
} from './polyline-geometry.js'

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
 * wrong cannot pass by agreeing with itself. The polyline geometry is
 * `polyline-geometry.ts`, shared with the scoreboards' oracles and, by a
 * guarded contract, with nothing under `layout/`.
 *
 * DEBT metrics target zero and each names a thing a reader would call a
 * mistake. PRICE metrics have no target: an edge that goes around a box
 * costs bends, and a board that keeps its labels clear costs envelope. They
 * are here so a change that buys less of one harm with more of another has
 * to say so. The columns stay a vector: the metric landscapes that measured
 * them (Mooney, Purchase, Wybrow & Kobourov, PacificVis 2024; Ahmed et al.,
 * TVCG 2022) found pairs that fight each other, and a weighted sum hides
 * which one lost.
 *
 * Where a column follows the graph-drawing literature it says so beside
 * its definition. The ranking that decides which are debt: crossings first
 * by a wide margin (Purchase, GD 1997), then continuity — a path that
 * doubles back, not merely one that bends (Ware et al., Information
 * Visualization 2002); a frame an edge runs through without connecting to
 * it is the c-planarity rule (Feng, Cohen & Eades, COCOON 1995); an edge's
 * ink through a box it does not connect is Dunne et al.'s "edge tunnel"
 * (IBM J. Res. & Dev. 2015); flow is judged by where the boxes sit rather
 * than by each arrow's angle, which is what correlated with readers
 * (Burattin et al., 2016, r=0.72 against 0.26 for angles). Crossing angle
 * and angular resolution are deliberately absent: on orthogonal routes
 * every crossing is a right angle and every fan is parallel, so both would
 * read 1.0 by construction, as Mooney et al. note of HOLA.
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
  /**
   * (edge, frame) pairs where the edge's ink runs inside a frame neither of
   * its ends belongs to — c-planarity's one rule, since a line through a
   * frame reads as a member of it.
   */
  readonly edgeThroughFrame: number
  /** Pairs of edges sharing a stretch of one line, where neither can be told from the other. */
  readonly edgeOverlaps: number
  /** That shared stretch, in px, over every such pair. */
  readonly sharedInkPx: number

  // ── PRICE ──────────────────────────────────────────────────────────────
  /** Places two edges visibly cross. */
  readonly crossings: number
  /** Corners along every edge. */
  readonly bends: number
  /** Ink drawn for every edge, in px. */
  readonly edgeLengthPx: number
  /** Adjacent gaps in one row or column that differ by more than a grid step. */
  readonly unevenGaps: number
  /**
   * Times an edge's path turns back on an axis it was already travelling —
   * the loop under a box and back over it. A bend is a corner; this is a
   * corner that undoes an earlier one, which is what continuity means.
   */
  readonly reversals: number
  /**
   * The direction most arrows travel, read from where their boxes sit:
   * the axis a head is displaced from its tail along, by majority.
   */
  readonly flow: Flow
  /** Arrows whose head sits before its tail along `flow`; a lateral arrow is neither. */
  readonly againstFlow: number
  /**
   * The counts above per edge and per pair of boxes, two decimals, so two
   * boards of different sizes compare. Crossings per edge is what OGDF and
   * ELK report; a theoretical maximum (Purchase's normalisation) has no
   * meaning for a routed path, which can cross as often as it turns.
   */
  readonly crossingsPerEdge: number
  readonly bendsPerEdge: number
  readonly overlapsPerPair: number
  /** The drawing's extent. */
  readonly envelopePx: { readonly w: number; readonly h: number }
  /** Box area over envelope area, two decimals; how much of the picture is content. */
  readonly density: number
}

export type Flow = 'down' | 'right' | 'up' | 'left' | 'none'

/**
 * The band tidy snaps within: two edges closer than this were meant to
 * line up, so a difference under it reads as a mistake rather than a choice.
 * Also the displacement under which two boxes count as side by side for
 * `flow`, so an arrow along a row a few pixels off is beside the flow.
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
const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/**
 * Where each arrow's head sits relative to its tail, by box centre. An
 * edge with an arrowhead at neither end, or at both, has no direction; a
 * head displaced less than `NEAR_MISS_PX` on both axes sits on its tail.
 */
function headings(canvas: SpatialCanvas, byId: ReadonlyMap<string, SpatialNode>): Point[] {
  const out: Point[] = []
  for (const edge of canvas.edges) {
    const from = byId.get(edge.fromNode)
    const to = byId.get(edge.toNode)
    if (from === undefined || to === undefined) continue
    const headArrow = edge.toEnd !== 'none'
    const tailArrow = edge.fromEnd === 'arrow'
    if (headArrow === tailArrow) continue
    const tail = centre(rectOf(headArrow ? from : to))
    const head = centre(rectOf(headArrow ? to : from))
    const d = { x: head.x - tail.x, y: head.y - tail.y }
    if (Math.abs(d.x) < NEAR_MISS_PX && Math.abs(d.y) < NEAR_MISS_PX) continue
    out.push(d)
  }
  return out
}

function flowOf(displacements: readonly Point[]): { flow: Flow; against: number } {
  const votes: Record<Exclude<Flow, 'none'>, number> = { down: 0, right: 0, up: 0, left: 0 }
  for (const d of displacements) {
    if (Math.abs(d.y) >= Math.abs(d.x)) votes[d.y > 0 ? 'down' : 'up']++
    else votes[d.x > 0 ? 'right' : 'left']++
  }
  const order = ['down', 'right', 'up', 'left'] as const
  const flow = order.reduce<Flow>((best, f) => {
    if (votes[f] === 0) return best
    return best === 'none' || votes[f] > votes[best as Exclude<Flow, 'none'>] ? f : best
  }, 'none')
  if (flow === 'none') return { flow, against: 0 }
  const axis = flow === 'down' || flow === 'up' ? 'y' : 'x'
  const sign = flow === 'down' || flow === 'right' ? 1 : -1
  const against = displacements.filter(
    (d) => Math.abs(d[axis]) >= NEAR_MISS_PX && Math.sign(d[axis]) === -sign,
  ).length
  return { flow, against }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const rate = (count: number, denominator: number) =>
  denominator === 0 ? 0 : round2(count / denominator)

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

  // An edge connecting a frame's member crosses its boundary once, which is
  // what a member's edge does; one connecting nothing in the frame has no
  // business inside it. Membership is judged by touch, so a straddling
  // endpoint is charged as a straddle and not again here.
  let edgeThroughFrame = 0
  for (const { edge, path } of edges) {
    const from = byId.get(edge.fromNode)
    const to = byId.get(edge.toNode)
    for (const g of groups) {
      const frame = rectOf(g)
      const touches = (n: SpatialNode | undefined) =>
        n !== undefined && (n.id === g.id || overlapArea(rectOf(n), frame) > 0)
      if (touches(from) || touches(to)) continue
      if (interiorInk(path, frame) > 0) edgeThroughFrame++
    }
  }

  let edgeOverlaps = 0
  let sharedInkPx = 0
  pairs(paths, (p, q) => {
    const shared = sharedInk(p, q)
    if (shared > 0) {
      edgeOverlaps++
      sharedInkPx += shared
    }
  })

  const { flow, against: againstFlow } = flowOf(headings(canvas, byId))

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
  // A frame's name is drawn above its frame, which for a nested frame is
  // inside the frame that holds it — painted first, so the name lies over
  // its fill and under nothing. Only a box the frame is NOT inside can hide it.
  let labelCovered = 0
  for (const label of runs) {
    if (label.annotates?.kind !== 'node') continue
    const own = byId.get(label.annotates.id)
    if (own === undefined) continue
    const hidden = nodes.some(
      (n) =>
        n.id !== own.id &&
        !(n.type === 'group' && contains(rectOf(n), rectOf(own))) &&
        overlapArea(label.bbox, rectOf(n)) > 0,
    )
    if (hidden) labelCovered++
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

  const crossings = crossingsOf(paths)
  const bendCount = paths.reduce((sum, p) => sum + bends(p), 0)

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
    edgeThroughFrame,
    edgeOverlaps,
    sharedInkPx: Math.round(sharedInkPx),
    crossings,
    bends: bendCount,
    edgeLengthPx: Math.round(paths.reduce((sum, p) => sum + pathLength(p), 0)),
    unevenGaps,
    reversals: paths.reduce((sum, p) => sum + reversals(p), 0),
    flow,
    againstFlow,
    crossingsPerEdge: rate(crossings, paths.length),
    bendsPerEdge: rate(bendCount, paths.length),
    overlapsPerPair: rate(nodeOverlaps, (boxes.length * (boxes.length - 1)) / 2),
    envelopePx: { w: Math.round(envelope.w), h: Math.round(envelope.h) },
    density: envelopeArea === 0 ? 0 : Math.round((boxArea / envelopeArea) * 100) / 100,
  }
}
