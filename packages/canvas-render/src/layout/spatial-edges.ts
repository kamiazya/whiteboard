import type { CanvasEdge, EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { ResolvedEdgeNode } from '../scene-graph.js'
import { buildPairwiseScores, scoreSegmentPair } from './edge-crossing-sweep.js'
import {
  addCost,
  bendCount,
  COST_QUANTUM,
  composeSidePairs,
  facingLaneWindow,
  fullyContains,
  hasRepairableProblem,
  interiorInkThrough,
  lessCost,
  oppositeSide,
  type Point,
  pairPenalty,
  type Rect,
  type Side,
  SLIDE_CORNER_INSET_PX,
  selfPenalty,
  shouldAdoptCandidate,
  zeroPenalty,
} from './edge-rules.js'
import { routeOnGrid } from './grid-route.js'

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
/**
 * Side-pair candidates ranked by ESTIMATED bends, best first — a thin
 * composer over the named PREFERENCE rules declared in edge-rules.ts
 * (decision #10 in package-canvas-render.md): a facing opposing pair whose
 * spans overlap routes as one straight segment (0 bends, dominant axis
 * first); a perpendicular L-pair reaches a genuinely diagonal target with
 * one bend; an opposing pair without a shared lane needs a two-bend Z; a
 * same-axis interpenetrating pair with no valid alternative falls back to
 * a U-hook. New routing feedback is one named rule + its own test in
 * edge-rules.ts, not a new branch here.
 */
function rankedSidePairs(
  dx: number,
  dy: number,
  fromRect: Rect,
  toRect: Rect,
  crowd: (end: 'from' | 'to', side: Side) => number,
): readonly { fromSide: Side; toSide: Side }[] {
  return composeSidePairs({ dx, dy, fromRect, toRect, crowd })
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
  // Ranking is geometric only; occlusion then moves an end that is buried
  // under a neighbour to its next exposed side.
  const best = pairs[0]!
  const pick = (rect: Rect, primary: Side, mirror: readonly [Side, Side, Side, Side]): Side => {
    const candidates = [primary, ...mirror.filter((sd) => sd !== primary)]
    return candidates.find((side) => exposed(rect, side)) ?? primary
  }
  const fromMirror = facingSides(dx, dy)
  const toMirror = fromMirror.map(oppositeSide) as unknown as readonly [Side, Side, Side, Side]
  const fromSide = pick(fromRect, best.fromSide, fromMirror)
  // partner-follows-moved-end: an arrival is chosen as the partner of a
  // particular departure, so when occlusion moves the departure the arrival
  // is left describing a pair that no longer exists — `left->bottom` with
  // the departure pushed to `top` becomes `top->bottom`, a combination the
  // ranking never proposed and which reaches the target's far side the long
  // way round. The coherent partner is the one on the axis the departure did
  // NOT take: leaving horizontally arrives on the vertical facing side, and
  // leaving vertically arrives on the horizontal one. Only the orphaned half
  // is replaced — an arrival occlusion never touched keeps its own choice.
  const horizontal = (side: Side) => side === 'left' || side === 'right'
  const { h, v } = {
    h: dx >= 0 ? ('right' as Side) : ('left' as Side),
    v: dy >= 0 ? ('bottom' as Side) : ('top' as Side),
  }
  const partnerSide =
    fromSide === best.fromSide ? best.toSide : oppositeSide(horizontal(fromSide) ? v : h)
  return { fromSide, toSide: pick(toRect, partnerSide, toMirror) }
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

/**
 * A frozen edge's full anchor state, for overrides that must not MOVE
 * mid-gesture: sides alone leave the anchor a fraction of its (node, side)
 * group, so a carried edge joining the group re-fractions a stationary
 * edge. Point/depth fields, when present, pin the committed positions.
 */
export interface EdgeAnchorOverride extends EdgeSides {
  readonly from?: Point
  readonly fromLaneDepth?: number
  readonly to?: Point
  readonly toLaneDepth?: number
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
  // Alignment never varies WITHIN one optimizer run: sliding anchors
  // mid-optimization changes trial costs, which shifts side-choice
  // equilibria on multi-edge canvases in ways the ranking never anticipated
  // (observed: a bystander edge re-siding onto a worse face). The search
  // proper therefore runs entirely unaligned, and `assignEdgeAnchors` hands
  // its settled configuration back through a SECOND, entirely aligned run —
  // see `optimizeSideChoices`'s own `align` parameter. Each run is internally
  // consistent, so neither can oscillate.
  align = true,
  // Committed anchor state to pin verbatim (live-drag bystanders): the
  // pinned ends still COUNT toward their group's fan-out fractions, so a
  // carried newcomer lands on a distinct lane, but their own placed
  // point/depth is the committed one — a stationary edge never moves.
  pins?: ReadonlyMap<string, EdgeAnchorOverride>,
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

  const applyPins = (): void => {
    if (pins === undefined) return
    for (const [id, pin] of pins) {
      const entry = anchors.get(id)
      if (entry === undefined) continue
      anchors.set(id, {
        ...entry,
        ...(pin.from !== undefined ? { from: pin.from } : {}),
        ...(pin.fromLaneDepth !== undefined ? { fromLaneDepth: pin.fromLaneDepth } : {}),
        ...(pin.to !== undefined ? { to: pin.to } : {}),
        ...(pin.toLaneDepth !== undefined ? { toLaneDepth: pin.toLaneDepth } : {}),
      })
    }
  }

  if (!align) {
    applyPins()
    return anchors
  }

  // A facing opposing pair whose ends are each ALONE on their side slides
  // both anchors to one tangent coordinate inside the shared lane —
  // realizing the straight segment the zero-bend rank promised, which the
  // per-side fraction placement above only delivers when the two side
  // midpoints happen to align. Multi-edge sides keep their fan-out
  // fractions: collapsing two corridors onto one lane is worse than a jog.
  for (const edge of edges) {
    // A pinned edge holds its committed anchors; alignment must not move it.
    if (pins?.get(edge.id)?.from !== undefined || pins?.get(edge.id)?.to !== undefined) continue
    const chosen = sides.get(edge.id)
    const entry = anchors.get(edge.id)
    if (chosen === undefined || entry?.from === undefined || entry.to === undefined) continue
    if (chosen.toSide !== oppositeSide(chosen.fromSide)) continue
    const fromNode = byId.get(edge.fromNode)
    const toNode = byId.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) continue
    if ((groups.get(`${edge.fromNode} ${chosen.fromSide}`)?.length ?? 0) > 1) continue
    if ((groups.get(`${edge.toNode} ${chosen.toSide}`)?.length ?? 0) > 1) continue
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    const axis = chosen.fromSide === 'left' || chosen.fromSide === 'right' ? 'h' : 'v'
    // Interpenetrating boxes (authored sides can force them) have no
    // forward-facing lane to slide into.
    const gapOk =
      axis === 'h'
        ? chosen.fromSide === 'right'
          ? fromRect.x + fromRect.w <= toRect.x
          : toRect.x + toRect.w <= fromRect.x
        : chosen.fromSide === 'bottom'
          ? fromRect.y + fromRect.h <= toRect.y
          : toRect.y + toRect.h <= fromRect.y
    if (!gapOk) continue
    const lane = facingLaneWindow(fromRect, toRect, axis)
    if (lane === undefined) continue
    const natural = (axis === 'h' ? entry.from.y + entry.to.y : entry.from.x + entry.to.x) / 2
    const t = Math.min(lane[1], Math.max(lane[0], natural))
    anchors.set(edge.id, {
      ...entry,
      from: axis === 'h' ? { x: entry.from.x, y: t } : { x: t, y: entry.from.y },
      to: axis === 'h' ? { x: entry.to.x, y: t } : { x: t, y: entry.to.y },
    })
  }
  applyPins()
  return anchors
}

/**
 * The routing cost of a configuration as a lexicographic integer tuple, one
 * slot per PENALTY_RULES tier (edge-rules.ts): total collinear axis-aligned
 * overlap length (a parallel overlap has no crossing point, so a line jump
 * cannot express it — heaviest; an edge RETRACING its own ink counts here
 * too, via `selfPenalty`), crossings too close to a segment end to render
 * their jump arc, total crossings, then total REALIZED bends. Bends sit
 * last and the optimizer's short-circuit ignores them (`hasRepairableProblem`):
 * they only break ties between configurations that already tie on every
 * visibility problem — the abstract pair ranking (L before Z) can lie once
 * obstacles force the L into a staircase, and this term is what corrects
 * it. Length stays out of the cost entirely, governed by the per-edge pair
 * ranking. `ConfigCost`'s length and slot order are DERIVED from
 * PENALTY_RULES (edge-rules.ts's `zeroPenalty`/`pairPenalty`/`selfPenalty`),
 * never hardcoded here.
 */
type ConfigCost = readonly number[]

/**
 * `pairScore`'s composition over PENALTY_RULES: sums the SHARED narrow
 * phase over every segment pair — the same function the initial sweep
 * calls, so the incremental trial path and the broad-phase build cannot
 * drift (see edge-crossing-sweep.ts) — then maps the summed triple into
 * the declared tiers.
 */
function pairScore(a: readonly Point[], b: readonly Point[]): ConfigCost {
  let overlap = 0
  let illegible = 0
  let crossings = 0
  for (let ai = 1; ai < a.length; ai++) {
    for (let bi = 1; bi < b.length; bi++) {
      const [o, il, c] = scoreSegmentPair(a[ai - 1]!, a[ai]!, b[bi - 1]!, b[bi]!)
      overlap += o
      illegible += il
      crossings += c
    }
  }
  return pairPenalty([overlap, illegible, crossings])
}

/**
 * Hard edge-count gate for the improvement pass. The initial matrix build
 * is a sweep-and-prune (edge-crossing-sweep.ts, ~3ms at 200 edges); the
 * remaining cost is the TRIAL loop, bounded above FULL_OPT_MAX_EDGES by
 * trying candidates only for the worst-offending edges (pathological
 * 200-edge canvases: ~150-200ms per committed layout on a dev machine —
 * paid only while the canvas actually has crossings/overlap, and never on
 * live-drag cached frames via the editor's carried-side cache). ponytail:
 * trial-loop incrementalization (persist the matrix across edits instead
 * of rebuilding per layout) is the next rung if this gate ever needs
 * raising further.
 */
const CROSSING_OPT_MAX_EDGES = 200
const CROSSING_OPT_MAX_PASSES = 2
/** At or under this many edges, every edge tries candidates (the exact
 * pre-sweep behavior); above it, only the worst offenders do. */
const FULL_OPT_MAX_EDGES = 40
/** How many worst-offender edges try candidates per pass above the full
 * size — the knob that bounds trial cost at any canvas size. */
const TRIAL_BUDGET_EDGES = 16

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
  // Whether trials are scored against ALIGNED anchors — the geometry that
  // will actually be drawn. The search proper runs unaligned (`false`): the
  // comment on `computeAnchorsFor`'s own `align` records why, and it still
  // holds. The cost is that a configuration can score clean in unaligned
  // trial space and acquire real defects once the final pass aligns it —
  // measured on a reported canvas, an edge settled on a route scoring
  // `[0,0,0,0,267,3,5]` after alignment while a candidate already in its
  // ranked list scored `[0,0,0,0,0,1,3]`, strictly better on every tier and
  // never adopted, because the search saw neither number. So the settled
  // configuration is handed back through this same search ONCE with
  // `align: true`. That is not the rejected mid-search alignment: costs
  // move only BETWEEN the two runs, never during either, so neither run's
  // equilibrium can oscillate.
  align = false,
  pins?: ReadonlyMap<string, EdgeAnchorOverride>,
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
  // Same edge, same anchors, same obstacles -> same path. A trial re-sides
  // ONE edge, but that recomputes the anchor groups it leaves and joins, so
  // the same (edge, anchor) combination comes back around repeatedly:
  // measured at 60 nodes / 200 edges, 296 of 854 routings were repeats of an
  // identical call, one combination recurring nine times. `nodes` and
  // `style` are fixed for the whole call, so they are not part of the key —
  // and the cache lives only as long as this call, so a later layout of a
  // moved canvas never sees a stale path.
  const routeCache = new Map<string, readonly Point[]>()
  const anchorKey = (edge: CanvasEdge, a: EdgeAnchorPair | undefined) =>
    `${edge.id}|${a?.fromSide}|${a?.toSide}|${a?.from?.x},${a?.from?.y}|${a?.to?.x},${a?.to?.y}|${a?.fromLaneDepth}|${a?.toLaneDepth}`
  const routeCached = (edge: CanvasEdge, a: EdgeAnchorPair | undefined): readonly Point[] => {
    const key = anchorKey(edge, a)
    const hit = routeCache.get(key)
    if (hit !== undefined) return hit
    const path = routeEdge(nodes, edge, style, a).path
    routeCache.set(key, path)
    return path
  }

  // Axis-aligned bounds per routed path, kept beside `paths`. Two edges
  // whose bounds are disjoint cannot overlap, cross, or sit illegibly close
  // to each other, so the pair scores zero without looking at a single
  // segment. `buildPairwiseScores` already prunes the FULL build this way
  // (200 edges in ~1.6ms); the per-trial update did not, and comparing one
  // re-routed edge against all 200 by brute force is where the search spent
  // most of its time.
  const boundsOf = (path: readonly Point[]): Rect => {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const point of path) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }
  // Inflated by one quantum so a pair that merely touches still reaches the
  // exact scorer: the broad phase must never be tighter than the thing it
  // is standing in for.
  const boundsOverlap = (a: Rect, b: Rect): boolean =>
    a.x - COST_QUANTUM <= b.x + b.w &&
    b.x - COST_QUANTUM <= a.x + a.w &&
    a.y - COST_QUANTUM <= b.y + b.h &&
    b.y - COST_QUANTUM <= a.y + a.h

  let current = new Map(initial)
  let anchors = computeAnchorsFor(nodes, edges, current, align, pins)
  let paths: (readonly Point[])[] = edges.map((e) => routeCached(e, anchors.get(e.id)))
  let bounds: Rect[] = paths.map(boundsOf)
  const pairKey = (i: number, j: number) => i * edges.length + j
  const matrix = new Map<number, ConfigCost>()
  // A rect that FULLY CONTAINS one of this edge's endpoints (a group frame
  // around its member) is not an obstacle: every route out of the contained
  // node crosses it, so there is nothing to route around. `routeEdge` has
  // always excluded them; the SEARCH did not, so it priced ink the router
  // could not avoid and could be talked into a detour to "save" it — the
  // same predicate `deriveDefaultSides`'s occlusion filter already uses.
  const foreignBodiesFor = edges.map((e) => {
    const endpoints = [byId.get(e.fromNode), byId.get(e.toNode)]
      .filter((n): n is SpatialNode => n !== undefined)
      .map(rectOf)
    return nodes
      .filter((n) => n.id !== e.fromNode && n.id !== e.toNode)
      .map(rectOf)
      .filter((r) => !endpoints.some((endpoint) => fullyContains(r, endpoint)))
  })
  // Every node's border, INCLUDING an edge's own endpoints — border-tracing
  // prices ink on a node's own outline, unlike foreignBodiesFor's tunnel
  // check which must exclude the edge's endpoints.
  const nodeBorders = nodes.map(rectOf)
  // Each edge's OWN endpoint rects (from, to) only — endpoint-body-ink's
  // interior check, unlike border-tracing's outline check above, needs to
  // know which two of nodeBorders belong to THIS edge.
  const endpointRectsFor = edges.map((e) =>
    [byId.get(e.fromNode), byId.get(e.toNode)]
      .filter((n): n is SpatialNode => n !== undefined)
      .map(rectOf),
  )
  const selfCosts: ConfigCost[] = paths.map((path, i) =>
    selfPenalty(path, foreignBodiesFor[i]!, nodeBorders, endpointRectsFor[i]),
  )
  let currentCost: ConfigCost = zeroPenalty()
  for (const self of selfCosts) currentCost = addCost(currentCost, self, 1)
  // Sweep-and-prune instead of the O(E^2) double loop: identical scores
  // by construction (same narrow phase, canonical pair order), sparse for
  // non-interacting pairs — evaluateTrial already zero-defaults absent
  // keys.
  for (const [key, [o, il, c]] of buildPairwiseScores(paths)) {
    const score: ConfigCost = pairPenalty([o, il, c])
    matrix.set(key, score)
    currentCost = addCost(currentCost, score, 1)
  }
  // The realized-bends tier is deliberately ABSENT from the short-circuit
  // (hasRepairableProblem, edge-rules.ts): a canvas with no overlap and no
  // crossings is healthy, and reshuffling it purely to shave bends is
  // churn, not repair.
  if (!hasRepairableProblem(currentCost)) return current

  const evaluateTrial = (
    trialSides: ReadonlyMap<string, SidePair>,
  ): {
    cost: ConfigCost
    anchors: ReadonlyMap<string, EdgeAnchorPair>
    paths: (readonly Point[])[]
    bounds: Rect[]
    touched: number[]
    updates: Map<number, ConfigCost>
    selfUpdates: Map<number, ConfigCost>
  } => {
    const trialAnchors = computeAnchorsFor(nodes, edges, trialSides, align, pins)
    const touched: number[] = []
    for (let i = 0; i < edges.length; i++) {
      if (!sameAnchor(anchors.get(edges[i]!.id), trialAnchors.get(edges[i]!.id))) touched.push(i)
    }
    const trialPaths = paths.slice()
    const trialBounds = bounds.slice()
    for (const i of touched) {
      trialPaths[i] = routeCached(edges[i]!, trialAnchors.get(edges[i]!.id))
      trialBounds[i] = boundsOf(trialPaths[i]!)
    }
    const touchedSet = new Set(touched)
    let cost = currentCost
    const updates = new Map<number, ConfigCost>()
    const selfUpdates = new Map<number, ConfigCost>()
    for (const i of touched) {
      const next = selfPenalty(
        trialPaths[i]!,
        foreignBodiesFor[i]!,
        nodeBorders,
        endpointRectsFor[i],
      )
      cost = addCost(cost, selfCosts[i] ?? zeroPenalty(), -1)
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
        if (!boundsOverlap(trialBounds[lo]!, trialBounds[hi]!)) {
          // Scores zero. Subtract whatever this pair used to cost and leave
          // the key absent — every reader already zero-defaults an absent
          // key — rather than paying for the segment sweep and two cost
          // tuples to arrive at the same answer.
          const prior = matrix.get(key)
          if (prior !== undefined) {
            cost = addCost(cost, prior, -1)
            updates.set(key, zeroPenalty())
          }
          continue
        }
        const next = pairScore(trialPaths[lo]!, trialPaths[hi]!)
        cost = addCost(cost, matrix.get(key) ?? zeroPenalty(), -1)
        cost = addCost(cost, next, 1)
        updates.set(key, next)
      }
    }
    return {
      cost,
      anchors: trialAnchors,
      paths: trialPaths,
      bounds: trialBounds,
      touched,
      updates,
      selfUpdates,
    }
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
    // The same-side U-hook fallback (for when every ranked-vocabulary pair
    // crosses, overlaps, or retraces) comes from rankedSidePairs' last rule,
    // `u-hook-span-exposed-first` — one producer, not a second list here.
    const pairs = rankedSidePairs(
      toCenter.x - fromCenter.x,
      toCenter.y - fromCenter.y,
      fromRect,
      toRect,
      () => 0,
    )
    const seen = new Set<string>()
    return pairs
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

  // Above the full-optimization size, each pass tries candidates only for
  // the WORST OFFENDERS — the edges contributing the most cost right now —
  // so trial work stays bounded at any canvas size while the edges that
  // actually look bad still improve. At or under the full size every edge
  // iterates in document order, bit-identical to the unbounded loop.
  const trialEdgesForPass = (): readonly CanvasEdge[] => {
    // The aligned run is a REPAIR pass over an already-settled
    // configuration, so it always takes the ranked-and-filtered list at
    // every size: an edge with nothing wrong with it has nothing for this
    // pass to fix, and trying candidates for it is the whole of the pass's
    // cost with none of its benefit.
    if (!align && edges.length <= FULL_OPT_MAX_EDGES) return edges
    const contribution = (i: number): ConfigCost => {
      let cost = selfCosts[i]!
      for (let j = 0; j < edges.length; j++) {
        if (j === i) continue
        const [lo, hi] = i < j ? [i, j] : [j, i]
        const pair = matrix.get(pairKey(lo, hi))
        if (pair !== undefined) cost = addCost(cost, pair, 1)
      }
      return cost
    }
    const ranked = edges
      .map((edge, i) => ({ edge, i, cost: contribution(i) }))
      // An edge with no overlap, no illegibility, and no crossings has
      // nothing to repair — reshuffling it to shave bends is churn, the
      // same judgement the whole-config short-circuit makes
      // (hasRepairableProblem, edge-rules.ts).
      .filter((r) => hasRepairableProblem(r.cost))
      .sort((a, b) => (lessCost(a.cost, b.cost) ? 1 : lessCost(b.cost, a.cost) ? -1 : a.i - b.i))
      .slice(0, TRIAL_BUDGET_EDGES)
      // Document order within the budget keeps adoption sequencing stable.
      .sort((a, b) => a.i - b.i)
    return ranked.map((r) => r.edge)
  }

  for (let pass = 0; pass < CROSSING_OPT_MAX_PASSES; pass++) {
    let improved = false
    for (const edge of trialEdgesForPass()) {
      if (locked?.has(edge.id)) continue
      const chosen = current.get(edge.id)
      if (chosen === undefined) continue
      for (const candidate of candidatesFor(edge)) {
        if (candidate.fromSide === chosen.fromSide && candidate.toSide === chosen.toSide) continue
        const trial = new Map(current)
        trial.set(edge.id, candidate)
        const evaluated = evaluateTrial(trial)
        // incumbent-wins-ties: adopt only on a strict decrease (edge-rules.ts),
        // so a tie never triggers churn and the lexicographic loop cannot oscillate.
        if (shouldAdoptCandidate(evaluated.cost, currentCost, lessCost)) {
          current = trial
          currentCost = evaluated.cost
          anchors = evaluated.anchors
          paths = evaluated.paths
          bounds = evaluated.bounds
          for (const [key, score] of evaluated.updates) matrix.set(key, score)
          for (const [i, score] of evaluated.selfUpdates) selfCosts[i] = score
          improved = true
          break
        }
      }
      if (!hasRepairableProblem(currentCost)) return current
    }
    if (!improved) break
  }
  return current
}

/**
 * Anchors for `sides`, with any edge whose two ends landed on the SAME point
 * re-sided onto a face that has room.
 *
 * Boxes that touch exactly produce that collision: flush-stacked nodes wired
 * bottom-to-top share the corner their fan-out spans meet at. The pair is
 * geometrically fine — the sides do face each other — and there is simply no
 * distance between them, so the route degenerates and the edge disappears.
 * An edge someone drew deliberately must not vanish, and the boxes are only
 * flush on ONE axis: the other one has space to route through, which is a
 * side CHOICE, not something the router can invent once the sides are fixed.
 *
 * Only the collided edges are re-sided, and an edge whose sides were
 * authored is left exactly as authored — a user who names both sides has
 * asked for that geometry, degenerate or not (routeOrthogonal still declines
 * to draw a spike for it).
 */
function anchorsWithoutCoincidentEnds(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  sides: ReadonlyMap<string, SidePair>,
  style: EdgeRoutingStyle,
  align: boolean,
  pins?: ReadonlyMap<string, EdgeAnchorOverride>,
): ReadonlyMap<string, EdgeAnchorPair> {
  const coincides = (anchors: ReadonlyMap<string, EdgeAnchorPair>, id: string): boolean => {
    const a = anchors.get(id)
    return a?.from !== undefined && a.to !== undefined && a.from.x === a.to.x && a.from.y === a.to.y
  }
  const anchors = computeAnchorsFor(nodes, edges, sides, align, pins)
  const collided = edges.filter(
    (edge) =>
      edge.fromNode !== edge.toNode &&
      (edge.fromSide === undefined || edge.toSide === undefined) &&
      coincides(anchors, edge.id),
  )
  if (collided.length === 0) return anchors

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const repaired = new Map(sides)
  for (const edge of collided) {
    const fromNode = byId.get(edge.fromNode)
    const toNode = byId.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) continue
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    const fromCenter = centerOf(fromRect)
    const toCenter = centerOf(toRect)
    const candidates = rankedSidePairs(
      toCenter.x - fromCenter.x,
      toCenter.y - fromCenter.y,
      fromRect,
      toRect,
      () => 0,
    )
    // Every candidate is scored, not just the first that qualifies. Two
    // predicates are needed and neither alone is enough: "not coincident"
    // alone accepted a pair that reached the far side straight THROUGH the
    // target, and "first clean one" alone accepted a four-bend loop around
    // both boxes when a short hop up the shared side was available. Clean is
    // the requirement; shortest-and-straightest picks among the clean.
    // Three tiers, because they are not equally important and treating them
    // as one filter made an edge vanish: a candidate that is clean AND has
    // runway is best, a clean one without runway still beats an ugly one, and
    // ANY visible route beats the collided pair. Visibility is the
    // requirement; the rest is preference.
    let best: { pair: SidePair; tier: number; bends: number; length: number } | undefined
    for (const pair of candidates) {
      const sided: SidePair = {
        fromSide: edge.fromSide ?? pair.fromSide,
        toSide: edge.toSide ?? pair.toSide,
      }
      const trial = new Map(repaired)
      trial.set(edge.id, sided)
      const trialAnchors = computeAnchorsFor(nodes, edges, trial, align, pins)
      if (coincides(trialAnchors, edge.id)) continue
      const { path } = routeEdge(nodes, edge, style, trialAnchors.get(edge.id))
      // The arrowhead is drawn ON the final segment; a shorter one paints an
      // arrow with no line under it. Re-siding is choosing this route from
      // scratch, so it can decline the ones that arrive with no runway.
      const tail = path[path.length - 1]
      const beforeTail = path[path.length - 2]
      const runway =
        tail === undefined || beforeTail === undefined
          ? 0
          : Math.hypot(tail.x - beforeTail.x, tail.y - beforeTail.y)
      const clean = interiorInkThrough(path, [fromRect, toRect]) === 0
      const scored = {
        pair: sided,
        tier: clean && runway >= ARROW_RUNWAY_PX ? 0 : clean ? 1 : 2,
        bends: bendCount(path),
        length: pathLength(path),
      }
      if (
        best === undefined ||
        scored.tier < best.tier ||
        (scored.tier === best.tier &&
          (scored.bends < best.bends ||
            (scored.bends === best.bends && scored.length < best.length)))
      ) {
        best = scored
      }
    }
    if (best !== undefined) repaired.set(edge.id, best.pair)
    // No candidate reaches it cleanly: keep the collided pair. routeOrthogonal
    // draws the shared point rather than a spike, so the worst case is an
    // invisible edge, never a wrong one.
  }
  return computeAnchorsFor(nodes, edges, repaired, align, pins)
}

/**
 * Side choices for a canvas of ANY size: `optimizeSideChoices` directly when
 * the edge set fits its gate, otherwise the same search run over spatial
 * REGIONS of the canvas.
 *
 * Past `CROSSING_OPT_MAX_EDGES` the search used to be skipped wholesale, and
 * "skipped" is not a small loss — measured on a 345-edge clustered canvas, one
 * avoidable-ink violation per edge, against 29 across the entire small corpus.
 * A canvas that big is exactly what an AI-authored document grows into, so the
 * size where quality stops mattering is not the size where it stops being
 * affordable.
 *
 * Regions work because interaction is local: on a canvas with any locality at
 * all, 4-5% of edge pairs survive a bounding-box test (55% on the deliberately
 * pathological stride canvas the bench also carries). Two edges in
 * well-separated regions were never going to be scored against each other
 * anyway, so optimizing region by region gives up little and costs
 * `regions * cost(regionSize)` instead of `cost(E)` — linear in the canvas
 * rather than super-linear.
 *
 * What it gives up, stated plainly: a crossing between edges assigned to two
 * different regions is never priced. Edges are grouped along a Morton curve
 * through their midpoints, so neighbours in space are neighbours in the
 * ordering and a split falls between clusters far more often than through one,
 * but nothing guarantees that.
 */
function optimizeAcrossRegions(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  style: EdgeRoutingStyle,
  initial: ReadonlyMap<string, SidePair>,
  locked?: ReadonlySet<string>,
  pins?: ReadonlyMap<string, EdgeAnchorOverride>,
): ReadonlyMap<string, SidePair> {
  const bothRuns = (
    regionEdges: readonly CanvasEdge[],
    seed: ReadonlyMap<string, SidePair>,
  ): ReadonlyMap<string, SidePair> => {
    const unaligned = optimizeSideChoices(nodes, regionEdges, style, seed, locked)
    return optimizeSideChoices(nodes, regionEdges, style, unaligned, locked, true, pins)
  }

  if (edges.length <= CROSSING_OPT_MAX_EDGES) return bothRuns(edges, initial)

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const midpoints = edges.map((edge) => {
    const from = byId.get(edge.fromNode)
    const to = byId.get(edge.toNode)
    if (from === undefined || to === undefined) return { x: 0, y: 0 }
    const a = centerOf(rectOf(from))
    const b = centerOf(rectOf(to))
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  })
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const m of midpoints) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue
    minX = Math.min(minX, m.x)
    minY = Math.min(minY, m.y)
    maxX = Math.max(maxX, m.x)
    maxY = Math.max(maxY, m.y)
  }
  // A degenerate extent (every midpoint on one point, or none finite) leaves
  // every key 0; the sort then falls back to document order, which is still
  // a total, deterministic grouping.
  const spanX = Number.isFinite(minX) ? Math.max(maxX - minX, 1) : 1
  const spanY = Number.isFinite(minY) ? Math.max(maxY - minY, 1) : 1
  const originX = Number.isFinite(minX) ? minX : 0
  const originY = Number.isFinite(minY) ? minY : 0
  const GRID = 1024
  const interleave = (v: number) => {
    // Spread 10 bits so x and y can be woven into one 20-bit key.
    let x = v & 0x3ff
    x = (x | (x << 16)) & 0x030000ff
    x = (x | (x << 8)) & 0x0300f00f
    x = (x | (x << 4)) & 0x030c30c3
    x = (x | (x << 2)) & 0x09249249
    return x
  }
  const mortonOf = (m: Point) => {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return 0
    const gx = Math.min(GRID - 1, Math.max(0, Math.floor(((m.x - originX) / spanX) * (GRID - 1))))
    const gy = Math.min(GRID - 1, Math.max(0, Math.floor(((m.y - originY) / spanY) * (GRID - 1))))
    return interleave(gx) | (interleave(gy) << 1)
  }
  const ordered = edges
    .map((edge, i) => ({ edge, i, key: mortonOf(midpoints[i] as Point) }))
    // Document order breaks key ties, so the grouping is a total function of
    // the canvas — two layouts of the same canvas never split it differently.
    .sort((a, b) => a.key - b.key || a.i - b.i)

  // Even-sized regions rather than cap-sized ones: cost grows super-linearly
  // inside a region, so two regions of 173 beat one of 200 plus one of 145.
  const regionCount = Math.ceil(edges.length / CROSSING_OPT_MAX_EDGES)
  const regionSize = Math.ceil(edges.length / regionCount)
  const settled = new Map(initial)
  for (let start = 0; start < ordered.length; start += regionSize) {
    const regionEdges = ordered.slice(start, start + regionSize).map((entry) => entry.edge)
    if (regionEdges.length < 2) continue
    const seed = new Map<string, SidePair>()
    for (const edge of regionEdges) {
      const pair = settled.get(edge.id)
      if (pair !== undefined) seed.set(edge.id, pair)
    }
    for (const [id, pair] of bothRuns(regionEdges, seed)) settled.set(id, pair)
  }
  return settled
}

export function assignEdgeAnchors(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  style: EdgeRoutingStyle = 'straight',
  // FROZEN side choices for the listed edges: route STABILITY over
  // optimality mid-gesture. Edges ABSENT from a provided map still run the
  // optimizer against the locked rest, so a live overlay's carried edges
  // side exactly as the committed render will; a map covering every edge
  // skips optimization wholesale (the live overlay's cached frames).
  // Sides settle again on the next committed render.
  sideOverrides?: ReadonlyMap<string, EdgeAnchorOverride>,
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
    // The live-drag path keeps the hard gate the committed path no longer
    // needs. Regional optimization is worth several hundred ms once, when a
    // change is committed; it is not worth it on a frame someone is dragging
    // through, and this branch exists precisely to serve those frames. A
    // canvas past the gate drags exactly as fast as it does today and picks
    // up its regional repair on drop.
    if (edges.length >= 2 && edges.length <= CROSSING_OPT_MAX_EDGES && locked.size < edges.length) {
      liveSides = optimizeAcrossRegions(nodes, edges, style, merged, locked, sideOverrides)
    }
    return anchorsWithoutCoincidentEnds(nodes, edges, liveSides, style, true, sideOverrides)
  }
  if (edges.length >= 2) {
    sides = optimizeAcrossRegions(nodes, edges, style, sides)
  }
  return anchorsWithoutCoincidentEnds(nodes, edges, sides, style, true)
}

/** An arrowhead's own length: a final segment shorter than this paints an
 * arrow with no line under it (see edge-arrows.ts's ARROW_LENGTH). */
const ARROW_RUNWAY_PX = 10

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
  endpointRects: readonly Rect[] = [],
): Point[] {
  // Scored once per candidate, not once per comparison: this runs per edge
  // on every layout, inside an optimizer that reroutes the whole edge set
  // several times.
  const scored = candidates.map((path) => ({
    path,
    ink: interiorInkThrough(path, endpointRects),
    length: pathLength(path),
    bends: bendCount(path),
  }))
  const ranked = scored
    .sort((a, b) => {
      if (a.ink !== b.ink) return a.ink - b.ink
      if (Math.abs(a.length - b.length) > 1e-6) return a.length - b.length
      return a.bends - b.bends
    })
    .map((c) => c.path)
  return (
    ranked.find((path) => pathIsClear(path, inflated)) ??
    ranked.find((path) => pathIsClear(path, raw)) ??
    (ranked[0] as Point[])
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
  startAnchor: Point,
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
  let start = startAnchor
  // Boxes that touch exactly can put both anchors on the same point — two
  // flush-stacked nodes wired bottom-to-top land on the shared corner of
  // their fan-out spans. There is no distance to route: the connection IS
  // that point. Everything below assumes a direction to leave and arrive
  // along, and with none it built a stub each way, drawing a spike 20px
  // into one box and 40px back through both.
  //
  // ponytail: this draws nothing rather than the wrong thing. A VISIBLE
  // connector between flush boxes would have to leave from a face with room
  // beside it, which is a side-choice decision (`rankedSidePairs`), not
  // something this function can invent after the sides are fixed.
  if (start.x === end.x && start.y === end.y) return [start, end]
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
  const toNormal = outwardNormal(toSide)
  // An arrowhead is ARROW_LENGTH long and is drawn ON the final segment, so
  // an approach shorter than this leaves the arrow with no line behind it —
  // it reads as a marker stuck to the box rather than an edge arriving at
  // it. Two arrow-lengths gives the head its own run plus the same again of
  // plain line.
  const MIN_APPROACH_PX = 20
  // Perpendicular pairs take their corner from the DEPARTURE anchor's
  // tangent coordinate, so the approach is only as long as that anchor is
  // far from the arrival side. Sliding the departure along its own side
  // lengthens it without adding a corner; a side with no room to slide
  // keeps the anchor and falls through to the stub-and-elbow path.
  if (fromSide !== toSide && fromSide !== oppositeSide(toSide)) {
    const approach = toNormal.x * (start.x - end.x) + toNormal.y * (start.y - end.y)
    if (approach > 0 && approach < MIN_APPROACH_PX) {
      const shortfall = MIN_APPROACH_PX - approach
      const slid = slideAlongSide(start, fromRect, fromSide, {
        x: start.x + toNormal.x * shortfall,
        y: start.y + toNormal.y * shortfall,
      })
      if (slid !== undefined) start = slid
    }
  }
  const exit = stubFrom(start, fromSide, fromDepth)
  const entry = stubFrom(end, toSide, toDepth)
  // The arrival stub exists so the last segment reaches the anchor from
  // OUTSIDE its side. When the elbow already sits outside, on the arrival
  // axis, the stub only buys a detour past the anchor and back — a 20px
  // excursion that reads as a hook and reverses direction on that axis.
  // The DEPARTURE stub is never dropped the same way: its depth is what
  // separates edges sharing one side into distinct corridors.
  const arrivesFromOutside = (point: Point) =>
    toNormal.x * (point.x - end.x) + toNormal.y * (point.y - end.y) > 0 &&
    (toNormal.x === 0 ? point.x === end.x : point.y === end.y)
  const between = (middles: readonly Point[]) => {
    const last = middles[middles.length - 1]
    const approach = last !== undefined && arrivesFromOutside(last) ? [] : [entry]
    return withoutRepeats([start, exit, ...middles, ...approach, end])
  }

  const endpointRects = [fromRect, toRect]
  const elbows = [between([{ x: entry.x, y: exit.y }]), between([{ x: exit.x, y: entry.y }])]
  // An elbow is good enough to stop here only if it is clear of the FOREIGN
  // obstacles AND puts no ink inside its own endpoints. Testing foreign
  // clearance alone returned an elbow that tunnelled straight through the
  // target's body without ever generating a detour — the endpoint rects are
  // not obstacles, so nothing reported the route as blocked.
  if (
    elbows.some(
      (path) => pathIsClear(path, inflated) && interiorInkThrough(path, endpointRects) === 0,
    )
  ) {
    return bestCandidate(elbows, inflated, raw, endpointRects)
  }

  // Detours are needed when the paths this style actually travels are
  // blocked — which the direct diagonal cannot answer, since an orthogonal
  // edge never travels it. Two obstacles can sit on the two elbows while
  // leaving that diagonal clear.
  //
  // An endpoint body the elbows cut through joins the region for the same
  // reason a foreign body does: it is what the route has to get around. It
  // can never be an obstacle for the CLEARANCE test — every route has to
  // reach a point on it — but it is a perfectly good thing to steer past.
  const crossedBy = (rect: Rect) =>
    elbows.some((path) =>
      path.some((point, i) => i > 0 && segmentCrossesRect(path[i - 1] as Point, point, rect)),
    )
  const region = unionRect([
    ...inflated.filter(crossedBy),
    ...endpointRects.filter((rect) => elbows.some((path) => interiorInkThrough(path, [rect]) > 0)),
  ])
  const candidates =
    region === undefined
      ? elbows
      : [
          ...elbows,
          ...detourCandidates(exit, entry, region).map((path) => between(path.slice(1, -1))),
        ]
  const enumerated = bestCandidate(candidates, inflated, raw, endpointRects)
  if (interiorInkThrough(enumerated, endpointRects) === 0 && pathIsClear(enumerated, raw)) {
    return enumerated
  }
  // Nothing enumerated works, so pay for a real search. It runs between the
  // STUBS, not the anchors, so the perpendicular departure and arrival the
  // rest of this function guarantees survive it — the grid only decides what
  // happens in between.
  const searched = routeOnGrid(exit, entry, [...raw, ...endpointRects], OBSTACLE_CLEARANCE_PX)
  return searched === undefined
    ? enumerated
    : bestCandidate([enumerated, between(searched.slice(1, -1))], inflated, raw, endpointRects)
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
