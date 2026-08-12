import type { CanvasEdge, EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { ResolvedEdgeNode } from '../scene-graph.js'
import { EDGE_JUMP_RADIUS_PX } from './edge-jumps.js'

type Side = 'top' | 'right' | 'bottom' | 'left'
type Point = { readonly x: number; readonly y: number }
type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

function rectOf(node: SpatialNode): Rect {
  return { x: node.x, y: node.y, w: node.width, h: node.height }
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/** Border-inclusive: a point sitting exactly on the rect's edge counts as inside. */
function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  )
}

function sidePoint(rect: Rect, side: Side): Point {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.w / 2, y: rect.y }
    case 'bottom':
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h }
    case 'left':
      return { x: rect.x, y: rect.y + rect.h / 2 }
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 }
  }
}

/** Strict interior: a point exactly on the border is NOT inside, so a node
 * merely touching another (tidy adjacent layouts) never reads as occluding. */
function strictlyInside(rect: Rect, point: Point): boolean {
  return (
    point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h
  )
}

function fullyContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

function oppositeSide(side: Side): Side {
  switch (side) {
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
  }
}

/**
 * Side preference for the FROM end, best first: the side facing the other
 * node on the dominant axis (the pre-existing default, so an unoccluded
 * canvas keeps its exact old sides), then the facing side of the other
 * axis, then their opposites. Ties (equal offsets) prefer the horizontal
 * axis — the same fixed tie-breaker the default derivation always had.
 */
function facingSides(dx: number, dy: number): readonly [Side, Side, Side, Side] {
  const h: Side = dx >= 0 ? 'right' : 'left'
  const v: Side = dy >= 0 ? 'bottom' : 'top'
  return Math.abs(dx) >= Math.abs(dy)
    ? [h, v, oppositeSide(v), oppositeSide(h)]
    : [v, h, oppositeSide(h), oppositeSide(v)]
}

/**
 * Deterministic default-side derivation for an edge with no explicit
 * fromSide/toSide, occlusion-aware: the preferred side is the pre-existing
 * center-offset derivation, but a side whose midpoint anchor sits strictly
 * INSIDE another node is skipped for the first exposed one. The endpoint
 * rects themselves are never obstacles (the edge has to reach them), so an
 * occluded anchor means the route legally cuts straight through the
 * occluding node — moving to an exposed side is what keeps it outside.
 *
 * Not occluders: the edge's other endpoint (entering the shared region IS
 * the edge's job), and any rect fully containing the endpoint node (a
 * group frame around its member occludes every side equally, which says
 * nothing about which side to prefer). With every side occluded the
 * derivation falls back to the preferred side, so fully-boxed-in nodes
 * keep the old behaviour.
 */
/** Minimum shared-lane width for a facing pair to count as zero-bend. A
 * narrower window forces the aligned anchor into both nodes' corner zones —
 * the "straight" segment runs down the seam between two corners, or (since
 * anchors are placed by side fraction, not dragged into the window) is not
 * realized at all and degrades to a shallow diagonal. Such pairs read far
 * better through the one-bend perpendicular L. */
const ZERO_LANE_MIN_OVERLAP_PX = 20

/** Inset tangent spans of two facing sides share a lane wide enough to host
 * an anchor — a zero-bend segment is actually realizable. */
function facingSpansOverlap(fromRect: Rect, toRect: Rect, axis: 'h' | 'v'): boolean {
  const span = (r: Rect): readonly [number, number] =>
    axis === 'h'
      ? [
          r.y + Math.min(SLIDE_CORNER_INSET_PX, r.h / 2),
          r.y + r.h - Math.min(SLIDE_CORNER_INSET_PX, r.h / 2),
        ]
      : [
          r.x + Math.min(SLIDE_CORNER_INSET_PX, r.w / 2),
          r.x + r.w - Math.min(SLIDE_CORNER_INSET_PX, r.w / 2),
        ]
  const [aLo, aHi] = span(fromRect)
  const [bLo, bHi] = span(toRect)
  return Math.min(aHi, bHi) - Math.max(aLo, bLo) >= ZERO_LANE_MIN_OVERLAP_PX
}

/**
 * Side-pair candidates ranked by ESTIMATED bends, best first:
 * a facing opposing pair whose spans overlap routes as one straight
 * segment (0 bends, dominant axis first); a perpendicular L-pair reaches a
 * genuinely diagonal target with one bend; an opposing pair without a
 * shared lane needs a two-bend Z. Ties between the two L-pairs break
 * toward the less crowded sides (`crowd`), so a departure prefers a side
 * other edges have not already claimed — fewer shared sides means fewer
 * fanned anchors and lane jogs. The old dominant-axis rule survives as
 * the ranking's tie-breaks, so aligned pairs keep their exact old sides.
 */
function rankedSidePairs(
  dx: number,
  dy: number,
  fromRect: Rect,
  toRect: Rect,
  crowd: (end: 'from' | 'to', side: Side) => number,
): readonly { fromSide: Side; toSide: Side }[] {
  const h: Side = dx >= 0 ? 'right' : 'left'
  const v: Side = dy >= 0 ? 'bottom' : 'top'
  const opposingH = { fromSide: h, toSide: oppositeSide(h) }
  const opposingV = { fromSide: v, toSide: oppositeSide(v) }
  const zero: { fromSide: Side; toSide: Side }[] = []
  // Zero-bend also needs the two sides to genuinely face each other: boxes
  // that interpenetrate along the facing axis (from's leading edge past
  // to's trailing edge) would route the "straight" segment backwards into
  // the overlap.
  const facingGapOk = (axis: 'h' | 'v'): boolean =>
    axis === 'h'
      ? h === 'right'
        ? fromRect.x + fromRect.w <= toRect.x
        : toRect.x + toRect.w <= fromRect.x
      : v === 'bottom'
        ? fromRect.y + fromRect.h <= toRect.y
        : toRect.y + toRect.h <= fromRect.y
  const zeroH = facingGapOk('h') && facingSpansOverlap(fromRect, toRect, 'h')
  const zeroV = facingGapOk('v') && facingSpansOverlap(fromRect, toRect, 'v')
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (zeroH) zero.push(opposingH)
    if (zeroV) zero.push(opposingV)
  } else {
    if (zeroV) zero.push(opposingV)
    if (zeroH) zero.push(opposingH)
  }
  const ls: { fromSide: Side; toSide: Side }[] = []
  if (dx !== 0 && dy !== 0) {
    const l1 = { fromSide: h, toSide: oppositeSide(v) }
    const l2 = { fromSide: v, toSide: oppositeSide(h) }
    const crowding = (p: { fromSide: Side; toSide: Side }) =>
      crowd('from', p.fromSide) + crowd('to', p.toSide)
    const dominantFirst = Math.abs(dx) >= Math.abs(dy) ? [l1, l2] : [l2, l1]
    ls.push(...dominantFirst.sort((a, b) => crowding(a) - crowding(b)))
  }
  // The opposing fallbacks keep the list total, but a pair that failed the
  // facing-gap check routes backwards through the overlap — offer it only
  // after every alternative. When collinear overlap leaves no L-pair AND no
  // valid opposing pair (same-axis boxes interpenetrating), a U-hook over a
  // shared side is the sane default, so it goes ahead of the invalid pairs.
  const ordered = Math.abs(dx) >= Math.abs(dy) ? [opposingH, opposingV] : [opposingV, opposingH]
  const gapOk = (p: { fromSide: Side }) => facingGapOk(p.fromSide === h ? 'h' : 'v')
  const fallback = [...ordered.filter(gapOk), ...ordered.filter((p) => !gapOk(p))]
  const uHooks: { fromSide: Side; toSide: Side }[] = []
  if (zero.length === 0 && ls.length === 0 && !ordered.some(gapOk)) {
    const across: Side = Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? 'bottom' : 'top') : h
    uHooks.push(
      { fromSide: across, toSide: across },
      { fromSide: oppositeSide(across), toSide: oppositeSide(across) },
    )
  }
  const seen = new Set<string>()
  return [...zero, ...ls, ...uHooks, ...fallback].filter((p) => {
    const key = `${p.fromSide} ${p.toSide}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function deriveDefaultSides(
  nodes: readonly SpatialNode[],
  edge: CanvasEdge,
  fromRect: Rect,
  toRect: Rect,
  crowd: (end: 'from' | 'to', side: Side) => number = () => 0,
): { fromSide: Side; toSide: Side } {
  const fromCenter = centerOf(fromRect)
  const toCenter = centerOf(toRect)
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y
  const pairs = rankedSidePairs(dx, dy, fromRect, toRect, crowd)
  const foreign = nodes.filter((n) => n.id !== edge.fromNode && n.id !== edge.toNode).map(rectOf)
  const exposed = (rect: Rect, side: Side): boolean => {
    const occluders = foreign.filter((r) => !fullyContains(r, rect))
    return !occluders.some((r) => strictlyInside(r, sidePoint(rect, side)))
  }
  // Ranking is geometric only; occlusion then adjusts each end
  // independently from the chosen pair (an occluded end moves to its next
  // exposed side alone, rather than dragging the other end with it).
  const best = pairs[0]!
  const pick = (rect: Rect, primary: Side, mirror: readonly [Side, Side, Side, Side]): Side => {
    const candidates = [primary, ...mirror.filter((sd) => sd !== primary)]
    return candidates.find((side) => exposed(rect, side)) ?? primary
  }
  const fromMirror = facingSides(dx, dy)
  const toMirror = fromMirror.map(oppositeSide) as unknown as readonly [Side, Side, Side, Side]
  return {
    fromSide: pick(fromRect, best.fromSide, fromMirror),
    toSide: pick(toRect, best.toSide, toMirror),
  }
}

/** Distance the self-edge loop bulges out along the selected side's outward normal, in px. */
const SELF_EDGE_LOOP_OFFSET_PX = 40
/** Half-width of the self-edge loop along the side perpendicular to the outward normal, in px. */
const SELF_EDGE_LOOP_SPREAD_PX = 20

/**
 * Two control points for a self-edge loop, offset outward from `start` along
 * `side`'s outward normal (not toward the node interior) and spread along the
 * perpendicular axis so the loop reads as a visible bulge rather than a
 * straight line back to itself.
 */
function selfEdgeLoopControlPoints(start: Point, side: Side): [Point, Point] {
  switch (side) {
    case 'right':
      return [
        { x: start.x + SELF_EDGE_LOOP_OFFSET_PX, y: start.y - SELF_EDGE_LOOP_SPREAD_PX },
        { x: start.x + SELF_EDGE_LOOP_OFFSET_PX, y: start.y + SELF_EDGE_LOOP_SPREAD_PX },
      ]
    case 'left':
      return [
        { x: start.x - SELF_EDGE_LOOP_OFFSET_PX, y: start.y - SELF_EDGE_LOOP_SPREAD_PX },
        { x: start.x - SELF_EDGE_LOOP_OFFSET_PX, y: start.y + SELF_EDGE_LOOP_SPREAD_PX },
      ]
    case 'top':
      return [
        { x: start.x - SELF_EDGE_LOOP_SPREAD_PX, y: start.y - SELF_EDGE_LOOP_OFFSET_PX },
        { x: start.x + SELF_EDGE_LOOP_SPREAD_PX, y: start.y - SELF_EDGE_LOOP_OFFSET_PX },
      ]
    case 'bottom':
      return [
        { x: start.x - SELF_EDGE_LOOP_SPREAD_PX, y: start.y + SELF_EDGE_LOOP_OFFSET_PX },
        { x: start.x + SELF_EDGE_LOOP_SPREAD_PX, y: start.y + SELF_EDGE_LOOP_OFFSET_PX },
      ]
  }
}

/** An edge's resolved endpoint positions, when the fan-out pass moved them. */
export interface EdgeAnchorPair {
  readonly from?: Point
  readonly to?: Point
  /** Stub depth for each end, when its (node, side) group assigned a lane. */
  readonly fromLaneDepth?: number
  readonly toLaneDepth?: number
  /**
   * The sides the anchor pass resolved. Side choice can depend on how
   * crowded each side is across the WHOLE edge set — information a single
   * routeEdge call does not have — so the pass records its choice and
   * routeEdge follows it, keeping the two producers agreeing.
   */
  readonly fromSide?: Side
  readonly toSide?: Side
}

/** The coordinate that orders ends along a side: y on vertical sides, x on horizontal. */
function tangentCoordinate(side: Side, point: Point): number {
  return side === 'left' || side === 'right' ? point.y : point.x
}

/** The point a fraction of the way along a side, 0 at its top/left end. */
function sidePointAt(rect: Rect, side: Side, fraction: number): Point {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.w * fraction, y: rect.y }
    case 'bottom':
      return { x: rect.x + rect.w * fraction, y: rect.y + rect.h }
    case 'left':
      return { x: rect.x, y: rect.y + rect.h * fraction }
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h * fraction }
  }
}

/**
 * Deterministic anchor positions for every edge end, spreading the ends
 * that share one (node, side) instead of stacking them all on the side's
 * midpoint. JSON Canvas authors a side but never a position along it, so
 * the position is the renderer's to choose — and a stack of ends at one
 * point makes edges with different colors or arrowheads read as a single
 * line until they diverge.
 *
 * Within a shared side, ends sit at fractions 1/(n+1) … n/(n+1), ordered
 * by where the FAR endpoint's center lies along the side's tangent axis so
 * routes leave in the order of their destinations and never cross right at
 * the node; ties (same far node, e.g. a bidirectional pair) fall back to
 * edge document order, then from-before-to. A side with a single end keeps
 * its midpoint, so canvases without shared sides render exactly as before.
 *
 * Edges with a missing endpoint get no entry — `routeEdge` already
 * degrades those to a zero-length path on its own.
 */
/** A resolved side pair for one edge, as consumed by `edgeSideOverrides`. */
export interface EdgeSides {
  readonly fromSide: Side
  readonly toSide: Side
}

type SidePair = EdgeSides

/**
 * The heuristic side choice per edge — authored sides applied, self-edges
 * pinned to their loop side, crowd-aware pair ranking for the rest. This
 * is the INITIAL configuration; `optimizeSideChoices` may re-side edges
 * whose guesses produce crossings or overlaps.
 */
function initialSideChoices(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
): Map<string, SidePair> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // Crowding estimate per (node, side): every edge end's PROSPECTIVE side
  // (authored, or the plain dominant-axis facing side — deliberately NOT
  // the crowd-aware derivation, which would recurse) — so a departure can
  // prefer a side other edges have not already claimed, deterministically
  // and independent of edge order.
  const crowdCounts = new Map<string, number>()
  const prospective = new Map<string, SidePair>()
  for (const edge of edges) {
    const fromNode = byId.get(edge.fromNode)
    const toNode = byId.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) continue
    if (edge.fromNode === edge.toNode) continue
    const fromCenter = centerOf(rectOf(fromNode))
    const toCenter = centerOf(rectOf(toNode))
    const primary = facingSides(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y)[0]
    const sides = {
      fromSide: edge.fromSide ?? primary,
      toSide: edge.toSide ?? oppositeSide(primary),
    }
    prospective.set(edge.id, sides)
    crowdCounts.set(
      `${edge.fromNode} ${sides.fromSide}`,
      (crowdCounts.get(`${edge.fromNode} ${sides.fromSide}`) ?? 0) + 1,
    )
    crowdCounts.set(
      `${edge.toNode} ${sides.toSide}`,
      (crowdCounts.get(`${edge.toNode} ${sides.toSide}`) ?? 0) + 1,
    )
  }
  const choices = new Map<string, SidePair>()
  for (const edge of edges) {
    const fromNode = byId.get(edge.fromNode)
    const toNode = byId.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) continue
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    const own = prospective.get(edge.id)
    const crowd = (end: 'from' | 'to', side: Side): number => {
      const nodeId = end === 'from' ? edge.fromNode : edge.toNode
      const ownSide = end === 'from' ? own?.fromSide : own?.toSide
      const count = crowdCounts.get(`${nodeId} ${side}`) ?? 0
      return ownSide === side ? count - 1 : count
    }
    const derived =
      edge.fromNode === edge.toNode
        ? { fromSide: 'right' as Side, toSide: 'right' as Side }
        : deriveDefaultSides(nodes, edge, fromRect, toRect, crowd)
    choices.set(edge.id, {
      fromSide: edge.fromSide ?? derived.fromSide,
      toSide: edge.toSide ?? derived.toSide,
    })
  }
  return choices
}

/** Grouping, anchor fan-out and lane depths for a FIXED side configuration. */
function computeAnchorsFor(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  sides: ReadonlyMap<string, SidePair>,
): ReadonlyMap<string, EdgeAnchorPair> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  type End = {
    readonly edgeId: string
    readonly edgeIndex: number
    readonly role: 'from' | 'to'
    readonly rect: Rect
    readonly side: Side
    readonly farCenter: Point
  }
  const groups = new Map<string, End[]>()
  edges.forEach((edge, edgeIndex) => {
    const fromNode = byId.get(edge.fromNode)
    const toNode = byId.get(edge.toNode)
    const chosen = sides.get(edge.id)
    if (fromNode === undefined || toNode === undefined || chosen === undefined) return
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    const ends: End[] = [
      {
        edgeId: edge.id,
        edgeIndex,
        role: 'from',
        rect: fromRect,
        side: chosen.fromSide,
        farCenter: centerOf(toRect),
      },
      {
        edgeId: edge.id,
        edgeIndex,
        role: 'to',
        rect: toRect,
        side: chosen.toSide,
        farCenter: centerOf(fromRect),
      },
    ]
    for (const end of ends) {
      const key = `${end.role === 'from' ? edge.fromNode : edge.toNode} ${end.side}`
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [end])
      else group.push(end)
    }
  })

  const anchors = new Map<
    string,
    {
      from?: Point
      to?: Point
      fromLaneDepth?: number
      toLaneDepth?: number
      fromSide?: Side
      toSide?: Side
    }
  >()
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        tangentCoordinate(a.side, a.farCenter) - tangentCoordinate(b.side, b.farCenter) ||
        a.edgeIndex - b.edgeIndex ||
        (a.role === b.role ? 0 : a.role === 'from' ? -1 : 1),
    )
    const placed = group.map((end, i) => ({
      end,
      point: sidePointAt(end.rect, end.side, (i + 1) / (group.length + 1)),
      t: tangentCoordinate(end.side, sidePointAt(end.rect, end.side, (i + 1) / (group.length + 1))),
    }))
    for (const member of placed) {
      // Depth by SWEEP RANK, not list index: a corridor travelling toward
      // its far endpoint passes every anchor between its own and that
      // direction, and must run deeper than all of their exit segments —
      // an index-ordered ladder gives a sweeping corridor a shallow lane
      // and forces a crossing right at the node that the connections
      // themselves never required. Ends that sweep past nothing share the
      // base depth; their corridors occupy disjoint tangent ranges.
      const dir = Math.sign(tangentCoordinate(member.end.side, member.end.farCenter) - member.t)
      const rank =
        dir === 0
          ? 0
          : placed.filter((other) => (dir > 0 ? other.t > member.t : other.t < member.t)).length
      const depth = ORTHOGONAL_STUB_PX + rank * STUB_LANE_STEP_PX
      const entry = anchors.get(member.end.edgeId) ?? {}
      anchors.set(
        member.end.edgeId,
        member.end.role === 'from'
          ? { ...entry, from: member.point, fromLaneDepth: depth, fromSide: member.end.side }
          : { ...entry, to: member.point, toLaneDepth: depth, toSide: member.end.side },
      )
    }
  }
  return anchors
}

/** Quarter-pixel quantization: every cost term is integral, so candidate
 * comparison is exact integer arithmetic — no float tie can differ between
 * platforms. */
const COST_QUANTUM = 4

type ConfigCost = readonly [overlap: number, illegible: number, crossings: number, bends: number]

function lessCost(a: ConfigCost, b: ConfigCost): boolean {
  if (a[0] !== b[0]) return a[0] < b[0]
  if (a[1] !== b[1]) return a[1] < b[1]
  if (a[2] !== b[2]) return a[2] < b[2]
  return a[3] < b[3]
}

/**
 * Global legibility cost of a routed configuration, as a lexicographic
 * integer tuple: total collinear axis-aligned overlap length (a parallel
 * overlap has no crossing point, so a line jump cannot express it —
 * heaviest; an edge RETRACING its own ink counts here too, via
 * `selfScore`), crossings too close to a segment end to render their jump
 * arc, total crossings, then total REALIZED bends. Bends sit last and the
 * optimizer's short-circuit ignores them: they only break ties between
 * configurations that already tie on every visibility problem — the
 * abstract pair ranking (L before Z) can lie once obstacles force the L
 * into a staircase, and this term is what corrects it. Length stays out
 * of the cost entirely, governed by the per-edge pair ranking.
 */
function pairScore(a: readonly Point[], b: readonly Point[]): ConfigCost {
  const q = (n: number) => Math.round(n * COST_QUANTUM)
  let overlap = 0
  let illegible = 0
  let crossings = 0
  const clearance = EDGE_JUMP_RADIUS_PX + 1
  for (let ai = 1; ai < a.length; ai++) {
    const a1 = a[ai - 1]!
    const a2 = a[ai]!
    for (let bi = 1; bi < b.length; bi++) {
      const b1 = b[bi - 1]!
      const b2 = b[bi]!
      // Collinear axis-aligned overlap.
      if (q(a1.y) === q(a2.y) && q(b1.y) === q(b2.y) && q(a1.y) === q(b1.y)) {
        const lo = Math.max(q(Math.min(a1.x, a2.x)), q(Math.min(b1.x, b2.x)))
        const hi = Math.min(q(Math.max(a1.x, a2.x)), q(Math.max(b1.x, b2.x)))
        if (hi > lo) overlap += hi - lo
        continue
      }
      if (q(a1.x) === q(a2.x) && q(b1.x) === q(b2.x) && q(a1.x) === q(b1.x)) {
        const lo = Math.max(q(Math.min(a1.y, a2.y)), q(Math.min(b1.y, b2.y)))
        const hi = Math.min(q(Math.max(a1.y, a2.y)), q(Math.max(b1.y, b2.y)))
        if (hi > lo) overlap += hi - lo
        continue
      }
      // Proper transversal crossing.
      const dax = a2.x - a1.x
      const day = a2.y - a1.y
      const dbx = b2.x - b1.x
      const dby = b2.y - b1.y
      const denom = dax * dby - day * dbx
      if (denom === 0) continue
      const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom
      const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue
      crossings++
      const lenA = Math.hypot(dax, day)
      const lenB = Math.hypot(dbx, dby)
      if (
        t * lenA < clearance ||
        (1 - t) * lenA < clearance ||
        u * lenB < clearance ||
        (1 - u) * lenB < clearance
      ) {
        illegible++
      }
    }
  }
  return [overlap, illegible, crossings, 0]
}

/**
 * Per-edge quality of ONE routed path, in the heaviest slot: collinear
 * overlap with ITSELF (adjacent retraces included — the doubled-line
 * arrival a facing-away side produces when the connector overshoots the
 * entry stub through the node body) plus the length of any segment
 * TUNNELLING through a bystander node's raw body — a line through a node
 * reads as though it connects that node, which no line jump can express,
 * so it outranks even an edge crossing. Realized bend count sits last.
 */
function selfScore(path: readonly Point[], foreignBodies: readonly Rect[]): ConfigCost {
  const q = (n: number) => Math.round(n * COST_QUANTUM)
  let overlap = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    for (const r of foreignBodies) {
      // Axis-aligned intrusion length, boundary grazing excluded: an
      // anchor ON a neighbour's border or a segment riding the margin
      // band is bestCandidate's business, not a tunnel.
      const minX = Math.max(Math.min(a.x, b.x), r.x)
      const maxX = Math.min(Math.max(a.x, b.x), r.x + r.w)
      const minY = Math.max(Math.min(a.y, b.y), r.y)
      const maxY = Math.min(Math.max(a.y, b.y), r.y + r.h)
      if (maxX <= minX && maxY <= minY) continue
      if (a.y === b.y && a.y > r.y && a.y < r.y + r.h && maxX > minX) {
        overlap += q(maxX - minX)
      } else if (a.x === b.x && a.x > r.x && a.x < r.x + r.w && maxY > minY) {
        overlap += q(maxY - minY)
      }
    }
  }
  for (let i = 1; i < path.length; i++) {
    for (let j = i + 1; j < path.length; j++) {
      const a1 = path[i - 1] as Point
      const a2 = path[i] as Point
      const b1 = path[j - 1] as Point
      const b2 = path[j] as Point
      if (q(a1.x) === q(a2.x) && q(b1.x) === q(b2.x) && q(a1.x) === q(b1.x)) {
        const lo = Math.max(q(Math.min(a1.y, a2.y)), q(Math.min(b1.y, b2.y)))
        const hi = Math.min(q(Math.max(a1.y, a2.y)), q(Math.max(b1.y, b2.y)))
        if (hi > lo) overlap += hi - lo
      } else if (q(a1.y) === q(a2.y) && q(b1.y) === q(b2.y) && q(a1.y) === q(b1.y)) {
        const lo = Math.max(q(Math.min(a1.x, a2.x)), q(Math.min(b1.x, b2.x)))
        const hi = Math.min(q(Math.max(a1.x, a2.x)), q(Math.max(b1.x, b2.x)))
        if (hi > lo) overlap += hi - lo
      }
    }
  }
  return [overlap, 0, 0, bendCount(path)]
}

function addCost(a: ConfigCost, b: ConfigCost, sign: 1 | -1): ConfigCost {
  return [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2], a[3] + sign * b[3]]
}

/**
 * Edge-count gate for the improvement pass. Trials evaluate incrementally
 * (only changed-anchor edges re-route; the pairwise matrix is patched),
 * but the initial matrix build is O(E^2) segment pairs and a committed
 * render pays the loop on every edit, so the bound keeps worst-case work
 * small (~24ms at the gate on a dev machine; per-frame surfaces opt out
 * entirely via edgeSideOverrides). ponytail: a sweepline pair scan is the
 * next rung if this gate ever needs raising.
 */
const CROSSING_OPT_MAX_EDGES = 40
const CROSSING_OPT_MAX_PASSES = 2

/**
 * Bounded global improvement over per-edge side choices: iterate edges in
 * document order; adopt an alternative ranked pair only when the WHOLE
 * configuration's cost strictly decreases (lexicographic integer compare —
 * deterministic, monotone, so the loop cannot oscillate). A crossing-free,
 * overlap-free configuration short-circuits without evaluating a single
 * candidate, which keeps the common case at one scoring sweep.
 */
function optimizeSideChoices(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  style: EdgeRoutingStyle,
  initial: ReadonlyMap<string, SidePair>,
  // Edges whose sides are held fixed: candidates are only tried for the
  // rest. The live-drag overlay locks resting edges (stability) while the
  // carried ones still get the same optimization the committed render
  // applies, so mid-drag and post-drop agree.
  locked?: ReadonlySet<string>,
): ReadonlyMap<string, SidePair> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sameAnchor = (a: EdgeAnchorPair | undefined, b: EdgeAnchorPair | undefined): boolean =>
    a?.from?.x === b?.from?.x &&
    a?.from?.y === b?.from?.y &&
    a?.to?.x === b?.to?.x &&
    a?.to?.y === b?.to?.y &&
    a?.fromLaneDepth === b?.fromLaneDepth &&
    a?.toLaneDepth === b?.toLaneDepth &&
    a?.fromSide === b?.fromSide &&
    a?.toSide === b?.toSide

  // Incremental state: per-edge routed paths, the pairwise score matrix,
  // and the aggregate cost. A trial re-sides ONE edge; only the edges
  // whose anchor entries actually changed (the trial edge plus members of
  // the anchor groups it left and joined) re-route and re-score their
  // pairs — everything else is carried over. This is what keeps a trial
  // O(affected * E) instead of O(E^2).
  let current = new Map(initial)
  let anchors = computeAnchorsFor(nodes, edges, current)
  let paths: (readonly Point[])[] = edges.map(
    (e) => routeEdge(nodes, e, style, anchors.get(e.id)).path,
  )
  const pairKey = (i: number, j: number) => i * edges.length + j
  const matrix = new Map<number, ConfigCost>()
  const foreignBodiesFor = edges.map((e) =>
    nodes.filter((n) => n.id !== e.fromNode && n.id !== e.toNode).map(rectOf),
  )
  const selfCosts: ConfigCost[] = paths.map((path, i) => selfScore(path, foreignBodiesFor[i]!))
  let currentCost: ConfigCost = [0, 0, 0, 0]
  for (const self of selfCosts) currentCost = addCost(currentCost, self, 1)
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const score = pairScore(paths[i]!, paths[j]!)
      matrix.set(pairKey(i, j), score)
      currentCost = addCost(currentCost, score, 1)
    }
  }
  // The bend term (index 3) is deliberately ABSENT from the short-circuit:
  // a canvas with no overlap and no crossings is healthy, and reshuffling
  // it purely to shave bends is churn, not repair.
  if (currentCost[0] === 0 && currentCost[1] === 0 && currentCost[2] === 0) return current

  const evaluateTrial = (
    trialSides: ReadonlyMap<string, SidePair>,
  ): {
    cost: ConfigCost
    anchors: ReadonlyMap<string, EdgeAnchorPair>
    paths: (readonly Point[])[]
    touched: number[]
    updates: Map<number, ConfigCost>
    selfUpdates: Map<number, ConfigCost>
  } => {
    const trialAnchors = computeAnchorsFor(nodes, edges, trialSides)
    const touched: number[] = []
    for (let i = 0; i < edges.length; i++) {
      if (!sameAnchor(anchors.get(edges[i]!.id), trialAnchors.get(edges[i]!.id))) touched.push(i)
    }
    const trialPaths = paths.slice()
    for (const i of touched) {
      trialPaths[i] = routeEdge(nodes, edges[i]!, style, trialAnchors.get(edges[i]!.id)).path
    }
    const touchedSet = new Set(touched)
    let cost = currentCost
    const updates = new Map<number, ConfigCost>()
    const selfUpdates = new Map<number, ConfigCost>()
    for (const i of touched) {
      const next = selfScore(trialPaths[i]!, foreignBodiesFor[i]!)
      cost = addCost(cost, selfCosts[i] ?? [0, 0, 0, 0], -1)
      cost = addCost(cost, next, 1)
      selfUpdates.set(i, next)
    }
    for (const i of touched) {
      for (let j = 0; j < edges.length; j++) {
        if (j === i) continue
        const [lo, hi] = i < j ? [i, j] : [j, i]
        const key = pairKey(lo, hi)
        if (updates.has(key)) continue
        // A pair between two touched edges is visited once thanks to the
        // updates map; a pair with an untouched edge reuses its cached path.
        if (touchedSet.has(j) && j < i) continue
        const next = pairScore(trialPaths[lo]!, trialPaths[hi]!)
        cost = addCost(cost, matrix.get(key) ?? [0, 0, 0, 0], -1)
        cost = addCost(cost, next, 1)
        updates.set(key, next)
      }
    }
    return { cost, anchors: trialAnchors, paths: trialPaths, touched, updates, selfUpdates }
  }

  const candidatesFor = (edge: CanvasEdge): SidePair[] => {
    if (edge.fromNode === edge.toNode) return []
    if (edge.fromSide !== undefined && edge.toSide !== undefined) return []
    const fromNode = byId.get(edge.fromNode)
    const toNode = byId.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) return []
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    const fromCenter = centerOf(fromRect)
    const toCenter = centerOf(toRect)
    const pairs = rankedSidePairs(
      toCenter.x - fromCenter.x,
      toCenter.y - fromCenter.y,
      fromRect,
      toRect,
      () => 0,
    )
    // U-pairs (both ends on the SAME compass side) are outside the ranked
    // vocabulary — the initial heuristic never wants them — but they are
    // exactly what hooks OVER everything when every ranked pair crosses,
    // overlaps, or retraces, and what a pair of overlapping nodes needs to
    // arrive without doubling back. Offered last: the optimizer only
    // adopts one on a strict cost decrease.
    const uPairs = (['top', 'right', 'bottom', 'left'] as const).map((side) => ({
      fromSide: side as Side,
      toSide: side as Side,
    }))
    const seen = new Set<string>()
    return [...pairs, ...uPairs]
      .map((pair) => ({
        fromSide: edge.fromSide ?? pair.fromSide,
        toSide: edge.toSide ?? pair.toSide,
      }))
      .filter((pair) => {
        const key = `${pair.fromSide} ${pair.toSide}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  for (let pass = 0; pass < CROSSING_OPT_MAX_PASSES; pass++) {
    let improved = false
    for (const edge of edges) {
      if (locked?.has(edge.id)) continue
      const chosen = current.get(edge.id)
      if (chosen === undefined) continue
      for (const candidate of candidatesFor(edge)) {
        if (candidate.fromSide === chosen.fromSide && candidate.toSide === chosen.toSide) continue
        const trial = new Map(current)
        trial.set(edge.id, candidate)
        const evaluated = evaluateTrial(trial)
        if (lessCost(evaluated.cost, currentCost)) {
          current = trial
          currentCost = evaluated.cost
          anchors = evaluated.anchors
          paths = evaluated.paths
          for (const [key, score] of evaluated.updates) matrix.set(key, score)
          for (const [i, score] of evaluated.selfUpdates) selfCosts[i] = score
          improved = true
          break
        }
      }
      if (currentCost[0] === 0 && currentCost[1] === 0 && currentCost[2] === 0) return current
    }
    if (!improved) break
  }
  return current
}

export function assignEdgeAnchors(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  style: EdgeRoutingStyle = 'straight',
  // FROZEN side choices for the listed edges: the caller opts out of the
  // optimization pass wholesale (a per-frame surface like the live drag
  // overlay wants route STABILITY over optimality mid-gesture, and cannot
  // afford the improvement loop each frame). Sides settle again on the
  // next committed render.
  sideOverrides?: ReadonlyMap<string, EdgeSides>,
): ReadonlyMap<string, EdgeAnchorPair> {
  let sides: ReadonlyMap<string, SidePair> = initialSideChoices(nodes, edges)
  if (sideOverrides !== undefined) {
    const merged = new Map(sides)
    const locked = new Set<string>()
    for (const [id, pair] of sideOverrides) {
      const edge = edges.find((e) => e.id === id)
      if (edge === undefined || merged.get(id) === undefined) continue
      merged.set(id, {
        fromSide: edge.fromSide ?? pair.fromSide,
        toSide: edge.toSide ?? pair.toSide,
      })
      locked.add(id)
    }
    // Edges OUTSIDE the override map (the carried ones) still go through
    // the optimizer, against the locked rest — initial ranking alone can
    // disagree with what the committed render will pick, and the drop
    // then visibly re-sides an edge the preview never showed that way.
    let liveSides: ReadonlyMap<string, SidePair> = merged
    if (edges.length >= 2 && edges.length <= CROSSING_OPT_MAX_EDGES && locked.size < edges.length) {
      liveSides = optimizeSideChoices(nodes, edges, style, merged, locked)
    }
    return computeAnchorsFor(nodes, edges, liveSides)
  }
  if (edges.length >= 2 && edges.length <= CROSSING_OPT_MAX_EDGES) {
    sides = optimizeSideChoices(nodes, edges, style, sides)
  }
  return computeAnchorsFor(nodes, edges, sides)
}

/** How close a route may pass to a foreign node's border, in px. */
const ROUTE_MARGIN_PX = 8

/** How far a detour keeps clear of the boxes it steps around, in px. */
const OBSTACLE_CLEARANCE_PX = 16

/**
 * Whether a segment passes through a rect's INTERIOR. Touching a border does
 * not count: every edge starts and ends on a border by construction, and a
 * route that grazes a corner is not the failure this is looking for.
 *
 * Slab method, with the parallel-to-an-axis case handled by the same
 * comparison rather than a special branch.
 */
function segmentCrossesRect(a: Point, b: Point, rect: Rect): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let enter = 0
  let exit = 1
  const slabs: readonly [number, number, number][] = [
    [dx, rect.x - a.x, rect.x + rect.w - a.x],
    [dy, rect.y - a.y, rect.y + rect.h - a.y],
  ]
  for (const [delta, near, far] of slabs) {
    if (delta === 0) {
      // Parallel to this axis: no crossing unless it already lies within.
      if (near > 0 || far < 0) return false
      continue
    }
    const t0 = Math.min(near / delta, far / delta)
    const t1 = Math.max(near / delta, far / delta)
    enter = Math.max(enter, t0)
    exit = Math.min(exit, t1)
    if (enter >= exit) return false
  }
  return exit > enter
}

const pathIsClear = (path: readonly Point[], obstacles: readonly Rect[]) =>
  path.every(
    (point, i) =>
      i === 0 || obstacles.every((rect) => !segmentCrossesRect(path[i - 1] as Point, point, rect)),
  )

function unionRect(rects: readonly Rect[]): Rect | undefined {
  const [first, ...rest] = rects
  if (first === undefined) return undefined
  let minX = first.x
  let minY = first.y
  let maxX = first.x + first.w
  let maxY = first.y + first.h
  for (const rect of rest) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

const pathLength = (path: readonly Point[]) =>
  path.reduce(
    (total, point, i) =>
      i === 0
        ? 0
        : total +
          Math.hypot(point.x - (path[i - 1] as Point).x, point.y - (path[i - 1] as Point).y),
    0,
  )

/**
 * A path from `start` to `end` that steps around everything in `obstacles`.
 *
 * Four candidates — over, under, left of, right of the blocking region — each
 * a pair of waypoints on one side of it. The shortest candidate that is
 * itself clear wins; if none is clear the shortest is used anyway, because
 * layout has to return SOMETHING and a route that still crosses is better
 * than a thrown error or a straight line through everything.
 *
 * Deliberately not a visibility graph or A*: this runs per edge on every
 * layout, and four candidates against a union box handles the arrangements
 * that actually occur (a node or two sitting between two others). A denser
 * search belongs behind the routing-style setting, not in the default path.
 */
/** Direction changes along a polyline, ignoring repeated/collinear points. */
function bendCount(path: readonly Point[]): number {
  let bends = 0
  let lastDir: string | undefined
  for (let i = 1; i < path.length; i++) {
    const dx = Math.sign((path[i] as Point).x - (path[i - 1] as Point).x)
    const dy = Math.sign((path[i] as Point).y - (path[i - 1] as Point).y)
    if (dx === 0 && dy === 0) continue
    const dir = `${dx},${dy}`
    if (lastDir !== undefined && dir !== lastDir) bends++
    lastDir = dir
  }
  return bends
}

/**
 * The best candidate by a two-tier clearance ranking, shortest first:
 * clear of the inflated obstacles (full margin kept), else clear of the
 * RAW node bodies (an anchor boxed inside a neighbour's margin band has
 * to cross the band to escape — that is acceptable; crossing the node
 * itself is not), else the shortest overall (layout has to return
 * SOMETHING).
 *
 * Equal-length candidates are ranked by BEND COUNT: the two stub-to-stub
 * elbows are always the same Manhattan length, so without this key the
 * arbitrary first candidate won even when the other ran collinear with
 * both stubs and drew one corner instead of three.
 */
function bestCandidate(
  candidates: readonly Point[][],
  inflated: readonly Rect[],
  raw: readonly Rect[],
): Point[] {
  const byLength = [...candidates].sort((a, b) => {
    const byLen = pathLength(a) - pathLength(b)
    if (Math.abs(byLen) > 1e-6) return byLen
    return bendCount(a) - bendCount(b)
  })
  return (
    byLength.find((path) => pathIsClear(path, inflated)) ??
    byLength.find((path) => pathIsClear(path, raw)) ??
    (byLength[0] as Point[])
  )
}

/** Ways past a blocking region: over it, under it, left of it, right of it. */
function detourCandidates(start: Point, end: Point, region: Rect): Point[][] {
  const above = region.y - OBSTACLE_CLEARANCE_PX
  const below = region.y + region.h + OBSTACLE_CLEARANCE_PX
  const leftOf = region.x - OBSTACLE_CLEARANCE_PX
  const rightOf = region.x + region.w + OBSTACLE_CLEARANCE_PX
  return [
    [start, { x: start.x, y: above }, { x: end.x, y: above }, end],
    [start, { x: start.x, y: below }, { x: end.x, y: below }, end],
    [start, { x: leftOf, y: start.y }, { x: leftOf, y: end.y }, end],
    [start, { x: rightOf, y: start.y }, { x: rightOf, y: end.y }, end],
  ]
}

/** The union of whatever `start`→`end` runs through, if anything does. */
function blockingRegion(start: Point, end: Point, obstacles: readonly Rect[]): Rect | undefined {
  return unionRect(obstacles.filter((rect) => segmentCrossesRect(start, end, rect)))
}

function routeStraight(
  start: Point,
  end: Point,
  inflated: readonly Rect[],
  raw: readonly Rect[],
): Point[] {
  const region = blockingRegion(start, end, inflated)
  if (region === undefined) return [start, end]
  return bestCandidate(detourCandidates(start, end, region), inflated, raw)
}

/**
 * Whether a straight run from `anchor` toward `other` would leave through
 * the anchor side's outward half-plane. When it would not (the direction
 * grazes along the side or points back across the node — the shape an
 * occlusion-moved side produces), the edge needs a perpendicular stub
 * first, or it draws sliding along the node's own border and the arrowhead
 * meets the side edge-on.
 */
/** Below this outward-to-tangential ratio (~14°), an approach reads as
 * running along the side rather than into it. */
const SIDEWAYS_RATIO = 0.25

function approachesSideways(anchor: Point, other: Point, side: Side): boolean {
  const vx = other.x - anchor.x
  const vy = other.y - anchor.y
  // Coincident anchors have no direction to graze along — the degenerate
  // zero-length path stays minimal rather than growing stubs.
  if (vx === 0 && vy === 0) return false
  const normal = outwardNormal(side)
  const outward = normal.x * vx + normal.y * vy
  const tangential = Math.abs(normal.x * vy - normal.y * vx)
  return outward <= tangential * SIDEWAYS_RATIO
}

/** How close to a side's corner a slid anchor may sit, in px. */
const SLIDE_CORNER_INSET_PX = 10

/**
 * The anchor slid along its side so the run to `target` is axis-aligned,
 * or undefined when the target's coordinate falls outside the side's span
 * (keeping a corner inset). A side midpoint is a default, not authored
 * data — trading it for a rectilinear route is the better-looking edge.
 */
function slideAlongSide(anchor: Point, rect: Rect, side: Side, target: Point): Point | undefined {
  if (side === 'left' || side === 'right') {
    const lo = rect.y + Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2)
    const hi = rect.y + rect.h - Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2)
    return target.y >= lo && target.y <= hi ? { x: anchor.x, y: target.y } : undefined
  }
  const lo = rect.x + Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2)
  const hi = rect.x + rect.w - Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2)
  return target.x >= lo && target.x <= hi ? { x: target.x, y: anchor.y } : undefined
}

/**
 * The straight style, with a perpendicular stub inserted at any end whose
 * direct segment would graze along its own side (see `approachesSideways`).
 * With neither end sideways this is exactly `routeStraight`, so every
 * facing-pair canvas keeps its two-point segment. When exactly one end is
 * sideways, the clean end's anchor slides along its own side to meet the
 * stub corridor squarely — one long axis-aligned run plus one right-angle
 * turn, instead of a diagonal into the stub.
 */
function routeStraightWithApproach(
  start: Point,
  end: Point,
  fromSide: Side,
  toSide: Side,
  fromRect: Rect,
  toRect: Rect,
  fromDepth: number,
  toDepth: number,
  inflated: readonly Rect[],
  raw: readonly Rect[],
): Point[] {
  const fromSideways = approachesSideways(start, end, fromSide)
  const toSideways = approachesSideways(end, start, toSide)
  if (!fromSideways && !toSideways) return routeStraight(start, end, inflated, raw)
  if (toSideways && !fromSideways) {
    const entry = stubFrom(end, toSide, toDepth)
    const slid = slideAlongSide(start, fromRect, fromSide, entry)
    if (slid !== undefined) {
      return withoutRepeats([...routeStraight(slid, entry, inflated, raw), end])
    }
  }
  if (fromSideways && !toSideways) {
    const exit = stubFrom(start, fromSide, fromDepth)
    const slid = slideAlongSide(end, toRect, toSide, exit)
    if (slid !== undefined) {
      return withoutRepeats([start, ...routeStraight(exit, slid, inflated, raw)])
    }
  }
  const exit = fromSideways ? stubFrom(start, fromSide, fromDepth) : start
  const entry = toSideways ? stubFrom(end, toSide, toDepth) : end
  return withoutRepeats([start, ...routeStraight(exit, entry, inflated, raw), end])
}

/** How far an orthogonal edge travels straight out of a node before turning. */
const ORTHOGONAL_STUB_PX = 20
/** Extra stub depth per additional member of a shared (node, side) group,
 * so ends sharing a side leave through parallel DISTINCT corridors instead
 * of one collinear overlap that a line jump cannot express. One-sided and
 * strictly additive: lane 0 keeps the exact base depth (unshared canvases
 * are byte-identical), deeper lanes only ever move AWAY from their node.
 * ponytail: depth grows unbounded with group size — a ~15-edge side pushes
 * the deepest stub ~200px out; cap distinct lanes and share the outermost
 * if that ever hurts. */
const STUB_LANE_STEP_PX = 12

/** The direction a side faces, away from the node's interior. */
function outwardNormal(side: Side): Point {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
  }
}

function stubFrom(point: Point, side: Side, depth: number = ORTHOGONAL_STUB_PX): Point {
  const normal = outwardNormal(side)
  return {
    x: point.x + normal.x * depth,
    y: point.y + normal.y * depth,
  }
}

/** Drops repeated points, so a collapsed corner never becomes a zero-length segment. */
function withoutRepeats(path: readonly Point[]): Point[] {
  return path.filter((point, i) => {
    const prev = path[i - 1]
    return i === 0 || prev === undefined || point.x !== prev.x || point.y !== prev.y
  })
}

/**
 * Right angles only, whether or not anything is in the way — that is what the
 * style asks for, so a clear path bends too.
 *
 * Both ends leave along their side's outward normal before turning. Without
 * that stub an edge attached to a node's right side can start by running
 * vertically, tracing the node's own border for its first segment so the two
 * read as one line rather than as an edge meeting a box.
 *
 * The elbows come first and the detours join them only when something blocks,
 * which keeps the common case to a single corner instead of routing every
 * edge around a region that is not there.
 */
function routeOrthogonal(
  start: Point,
  end: Point,
  fromSide: Side,
  toSide: Side,
  fromRect: Rect,
  toRect: Rect,
  fromDepth: number,
  toDepth: number,
  inflated: readonly Rect[],
  raw: readonly Rect[],
): Point[] {
  // Zero-bend shortcut: two ends on OPPOSING, mutually facing sides can
  // often share one tangent coordinate — anchors are renderer-chosen
  // defaults, so sliding one end along its side buys a single straight
  // segment instead of a stub-jog-stub elbow. Facing is required (each
  // side's outward normal points toward the other end), or an authored
  // opposing pair with the nodes swapped would draw a line backwards
  // through both. A blocked lane falls through to the elbows.
  if (fromSide === oppositeSide(toSide)) {
    const fromNormal = outwardNormal(fromSide)
    const facing = fromNormal.x * (end.x - start.x) + fromNormal.y * (end.y - start.y) > 0
    if (facing) {
      const span = (rect: Rect, side: Side): readonly [number, number] =>
        side === 'left' || side === 'right'
          ? [
              rect.y + Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2),
              rect.y + rect.h - Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2),
            ]
          : [
              rect.x + Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2),
              rect.x + rect.w - Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2),
            ]
      const withTangent = (anchor: Point, side: Side, t: number): Point =>
        side === 'left' || side === 'right' ? { x: anchor.x, y: t } : { x: t, y: anchor.y }
      const [fromLo, fromHi] = span(fromRect, fromSide)
      const [toLo, toHi] = span(toRect, toSide)
      const lo = Math.max(fromLo, toLo)
      const hi = Math.min(fromHi, toHi)
      if (lo <= hi) {
        const startT = tangentCoordinate(fromSide, start)
        const endT = tangentCoordinate(toSide, end)
        // Keep an existing anchor when one already lies in the shared
        // lane (departure first, then the arrival's fan position), else
        // move as little as possible.
        const t =
          startT >= lo && startT <= hi
            ? startT
            : endT >= lo && endT <= hi
              ? endT
              : Math.min(hi, Math.max(lo, startT))
        const alignedStart = withTangent(start, fromSide, t)
        const alignedEnd = withTangent(end, toSide, t)
        if (pathIsClear([alignedStart, alignedEnd], inflated)) {
          return [alignedStart, alignedEnd]
        }
      }
    }
  }
  const exit = stubFrom(start, fromSide, fromDepth)
  const entry = stubFrom(end, toSide, toDepth)
  const between = (middles: readonly Point[]) =>
    withoutRepeats([start, exit, ...middles, entry, end])

  const elbows = [between([{ x: entry.x, y: exit.y }]), between([{ x: exit.x, y: entry.y }])]
  if (elbows.some((path) => pathIsClear(path, inflated))) {
    return bestCandidate(elbows, inflated, raw)
  }

  // Detours are needed when the paths this style actually travels are
  // blocked — which the direct diagonal cannot answer, since an orthogonal
  // edge never travels it. Two obstacles can sit on the two elbows while
  // leaving that diagonal clear.
  const region = unionRect(
    inflated.filter((rect) =>
      elbows.some((path) =>
        path.some((point, i) => i > 0 && segmentCrossesRect(path[i - 1] as Point, point, rect)),
      ),
    ),
  )
  const candidates =
    region === undefined
      ? elbows
      : [
          ...elbows,
          ...detourCandidates(exit, entry, region).map((path) => between(path.slice(1, -1))),
        ]
  return bestCandidate(candidates, inflated, raw)
}

/**
 * Resolves one canvas-model edge into a scene-graph edge with a concrete
 * point path. Pure function of (nodes, edge): never throws — a missing
 * endpoint id degenerates to a zero-length path at the origin rather than
 * raising, so a single bad reference never aborts layout for the rest of
 * the canvas.
 *
 * The path steps around any OTHER node between the endpoints; an edge drawn
 * straight through a node reads as though it connects that node instead. The
 * two endpoint nodes are never obstacles — the edge has to reach them.
 */
export function routeEdge(
  nodes: readonly SpatialNode[],
  edge: CanvasEdge,
  style: EdgeRoutingStyle = 'straight',
  // Endpoint override from `assignEdgeAnchors`'s fan-out pass; an absent
  // field keeps the side midpoint, so single callers stay unchanged.
  anchors?: EdgeAnchorPair,
): ResolvedEdgeNode {
  const fromNode = nodes.find((n) => n.id === edge.fromNode)
  const toNode = nodes.find((n) => n.id === edge.toNode)

  // JSON Canvas 1.0 defaults: no source arrowhead, a destination arrowhead.
  const fromEnd = edge.fromEnd ?? 'none'
  const toEnd = edge.toEnd ?? 'arrow'

  if (!fromNode || !toNode) {
    const origin = { x: 0, y: 0 }
    return {
      kind: 'edge',
      id: edge.id,
      path: [origin, origin],
      fromSide: edge.fromSide ?? 'right',
      toSide: edge.toSide ?? 'left',
      fromEnd,
      toEnd,
    }
  }

  const fromRect = rectOf(fromNode)
  const toRect = rectOf(toNode)

  // Self-edge: no meaningful "other node" direction, so fix a stable loop
  // shape (right side out, right side back) rather than deriving from a
  // zero center-offset.
  if (edge.fromNode === edge.toNode) {
    const fromSide: Side = edge.fromSide ?? 'right'
    const toSide: Side = edge.toSide ?? 'right'
    const start = anchors?.from ?? sidePoint(fromRect, fromSide)
    const [loopOut, loopBack] = selfEdgeLoopControlPoints(start, fromSide)
    const end = anchors?.to ?? sidePoint(toRect, toSide)
    return {
      kind: 'edge',
      id: edge.id,
      path: [start, loopOut, loopBack, end],
      fromSide,
      toSide,
      fromEnd,
      toEnd,
    }
  }

  const derived = deriveDefaultSides(nodes, edge, fromRect, toRect)
  // The anchor pass resolves sides with whole-edge-set crowding knowledge a
  // single call lacks; when it spoke, follow it (authored sides still win).
  const fromSide = edge.fromSide ?? anchors?.fromSide ?? derived.fromSide
  const toSide = edge.toSide ?? anchors?.toSide ?? derived.toSide

  const start = anchors?.from ?? sidePoint(fromRect, fromSide)
  const end = anchors?.to ?? sidePoint(toRect, toSide)
  // A rect that contains an endpoint can never be routed around — every
  // detour still has to reach the point inside it — so it is not an
  // obstacle. This is what lets an edge between two members of a group run
  // inside the group's frame instead of detouring around it.
  // Endpoint containment excludes an obstacle on its RAW bounds — a node
  // whose margin band merely brushes an anchor must still block the route
  // from crossing its body. Routing then tests the margin-inflated rects
  // so a route keeps visible clearance from foreign borders; when an
  // anchor is boxed inside a neighbour's margin band, `bestCandidate`'s
  // second tier accepts a band crossing to escape rather than tunnelling
  // through the node itself.
  const rawObstacles = nodes
    .filter((n) => n.id !== edge.fromNode && n.id !== edge.toNode)
    .map(rectOf)
    .filter((rect) => !containsPoint(rect, start) && !containsPoint(rect, end))
  const obstacles = rawObstacles.map((rect) => ({
    x: rect.x - ROUTE_MARGIN_PX,
    y: rect.y - ROUTE_MARGIN_PX,
    w: rect.w + 2 * ROUTE_MARGIN_PX,
    h: rect.h + 2 * ROUTE_MARGIN_PX,
  }))

  return {
    kind: 'edge',
    id: edge.id,
    // 'curved' travels the same waypoints as 'orthogonal' — perpendicular
    // exit and entry, obstacles stepped around — and differs only in asking
    // for those corners to be drawn rounded. Keeping one set of waypoints is
    // what makes the two styles agree about which nodes an edge avoids; only
    // the drawing differs.
    path:
      style === 'straight'
        ? routeStraightWithApproach(
            start,
            end,
            fromSide,
            toSide,
            fromRect,
            toRect,
            anchors?.fromLaneDepth ?? ORTHOGONAL_STUB_PX,
            anchors?.toLaneDepth ?? ORTHOGONAL_STUB_PX,
            obstacles,
            rawObstacles,
          )
        : routeOrthogonal(
            start,
            end,
            fromSide,
            toSide,
            fromRect,
            toRect,
            anchors?.fromLaneDepth ?? ORTHOGONAL_STUB_PX,
            anchors?.toLaneDepth ?? ORTHOGONAL_STUB_PX,
            obstacles,
            rawObstacles,
          ),
    ...(style === 'curved' ? { rounded: true as const } : {}),
    fromSide,
    toSide,
    fromEnd,
    toEnd,
  }
}
