/**
 * One-tap tidy: deterministic normalization that respects the author's
 * rough topology instead of re-laying the canvas out wholesale.
 *
 * Four passes over UNITS (an outermost group and everything more than half
 * inside its box move as one; every other node is its own unit), applied
 * INSIDE each frame first and then at the level of the frames themselves:
 *
 * 0. Inside a frame: its members are tidied as a canvas of their own (the
 *    same three passes, recursively for nested frames), and the frame then
 *    GROWS — never shrinks — to hold them with `TIDY_MARGIN_PX` on every
 *    side, when it is unlocked and it or one of its members is in scope.
 *    Its top-left stays put: a member hugging that corner is moved in to
 *    the margin instead, so the frame keeps its alignment with its peers.
 *    Without this a frame was opaque: a member overlapping its neighbour,
 *    or jammed against the frame's edge, was something tidy could not
 *    see, and `tidy` scoped to a frame's members moved nothing at all.
 * 1. Band alignment, per axis and per anchor a drawer sets — the near
 *    edge, then the centre, then on x the far edge: units whose anchors sit
 *    within `TIDY_BAND_PX` of the band's FIRST member snap to one target —
 *    the anchor of the band's first IMMOBILE member when it has one (a
 *    neighbour that cannot move is the row, wherever it sits), or of one an
 *    earlier anchor already lined up, else the first member's own anchor
 *    with its edge put on the grid. Banding by the fixed first anchor —
 *    never a running mean — is what stops transitive chaining (A near B,
 *    C near B's new spot) from dragging a whole diagonal into one line. A
 *    unit in no band takes the grid at its edge; one centred under a wider
 *    neighbour keeps that centre, off the grid if it must, since a 4px miss
 *    on a centre reads as carelessly as one on a row.
 * 1b. Row order by edges, when the caller passes them: a box whose
 *    connections along its own row all lie to one side of it swaps places
 *    with the nearest of them, so a hub that fans out sits between the
 *    boxes it fans out to rather than at the end of the row, where the
 *    router paid for the placement with a crossing or a loop. The swap
 *    ends the condition that caused it, so it happens once.
 * 2. Overlap resolution as a deterministic sequential PLACEMENT: units in
 *    document order claim their spot; a unit overlapping anything already
 *    placed (or any immobile unit) hops along one axis — chosen once from
 *    its first collision — until clear by `TIDY_MARGIN_PX`. Every
 *    processed unit ends fully clear of everything before it, but that
 *    alone does not give idempotence: the passes can CYCLE, a snap and a
 *    hop each undoing the other. The loop below therefore stops at the
 *    first state it has already seen rather than only at a fixpoint, which
 *    holds the property either way (both are pinned by tests).
 * 3. Edge legibility is deliberately NOT tidy's job — once nodes settle,
 *    the edge optimizer re-routes and re-sides edges on the
 *    committed render.
 *
 * **The answer is a SETTLED state, and `tidyNodes` checks.** Every rule
 * above is local, so idempotence is a property of all of them together and
 * no single one can be held responsible for it — on a board with a FRAME it
 * did not hold at all: 11853 of 20000 crowded generated boards moved again
 * on a second tidy, a few of them for ever. Two local fixes closed all but
 * a tail — a member's grid laid from its FRAME's corner rather than the
 * board's zero, and a band that may not push one back out past the margin —
 * and `tidyNodes` closes the tail by re-entering until the state repeats,
 * which is the only thing that can answer for all of them at once. What
 * that costs is one more settling pass on a board tidy actually changed,
 * roughly double: 19ms -> 45ms on a 300-box, 8-frame board, which a tap can
 * pay.
 *
 * Pure and total: returns ONLY the boxes that actually move (a frame that
 * grew carries its new size); degenerate input never throws. Locked nodes
 * never move and stand as fixed obstacles, and a frame holding one is held
 * by it (moving the frame would carry it away from a member that cannot
 * follow); out-of-scope units likewise.
 */
import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'
import {
  AXES,
  AXIS_X,
  AXIS_Y,
  type Axis,
  ceilToGrid,
  onSomeAnchor,
  roundToGrid,
} from './tidy-axis.js'
import { alignBands } from './tidy-bands.js'
import {
  buildUnits,
  overlapsWithMargin,
  type Point,
  type Rect,
  rectOf,
  TIDY_BAND_PX,
  TIDY_GRID_PX,
  TIDY_MARGIN_PX,
  type TidyNode,
  type TidyOptions,
  type Unit,
  usable,
} from './tidy-units.js'

export type { TidyNode, TidyOptions } from './tidy-units.js'
export { tidyBoxes } from './tidy-units.js'

export interface TidyMove {
  readonly id: string
  readonly x: number
  readonly y: number
  /** Present only on a frame that grew to hold its members. */
  readonly width?: number
  readonly height?: number
}

/**
 * The anchors of what this level holds that a frame does not, and that the
 * MARGIN RULE CANNOT MOVE — anything locked or out of scope, and anything
 * that is not a frame's member, since the margin only ever moves those. A
 * member already lined up with one of them is already in a row, and the
 * margin anchor yields to it.
 *
 * The narrowing is the whole rule, and both halves were measured. Yielding
 * to any outside anchor also protects two members of two DIFFERENT frames
 * that are each about to snap to their own margin: they hold each other
 * where they are, and the corpus loses exactly the alignment the margin
 * anchor was added to buy (`nearMisses` 0 back to 2). Yielding to none of
 * them is what the eval lane caught — a model wrapped a chain in a group on
 * a board whose own row starts at x=0, and the first member was snapped 8px
 * off that row, three trials of three.
 *
 * Only ever a reason to YIELD, never to move anything, which is what keeps
 * this clear of the drift a guide that ATTRACTS brought when it was tried.
 */
function anchorsToYieldTo(
  nodes: readonly TidyNode[],
  members: ReadonlySet<string>,
  snappable: (id: string) => boolean,
) {
  const x: number[] = []
  const y: number[] = []
  for (const n of nodes) {
    if (members.has(n.id) || snappable(n.id)) continue
    x.push(n.x, n.x + n.width / 2, n.x + n.width)
    y.push(n.y, n.y + n.height / 2, n.y + n.height)
  }
  return { x, y }
}

/**
 * Row order by edges. A box whose connections along its own row all lie to
 * one side of it, two or more of them, is a hub drawn at the end of its
 * row: the edge to the farther box has to pass the nearer one, and the
 * router pays with a crossing or a loop under both. Measured on the lane's
 * layered board, the same hub between its targets reads crossings 1 -> 0,
 * bends 2 -> 0, reversals 1 -> 0 and a quarter less ink — and telling the
 * model so, in the skill and in the call's answer, moved nothing in nine
 * trials. So the hub swaps places with the nearest of them. After the swap
 * one connection lies on each side, so the condition no longer holds and a
 * second tidy moves nothing. Frames are left alone (a frame's order is its
 * members' business), and so is a hub or partner that cannot move.
 */
/**
 * The units this pass can reason about, by root id: a lone box, never a
 * frame. A frame's order is its members' business.
 */
function soleBoxUnits(units: readonly Unit[]): Map<string, Unit> {
  const byId = new Map<string, Unit>()
  for (const unit of units) {
    if (unit.members.length === 1 && unit.members[0]?.frame !== true) byId.set(unit.rootId, unit)
  }
  return byId
}

/** The id at `edge`'s other end, or `undefined` when it names neither. */
function otherEnd(edge: Pick<CanvasEdge, 'from' | 'to'>, id: string): string | undefined {
  if (endNode(edge.from) === id) return endNode(edge.to)
  if (endNode(edge.to) === id) return endNode(edge.from)
  return undefined
}

/** `hub`'s connections that are lone boxes sitting in its own row. */
function partnersAlongRow(
  hub: Unit,
  edges: readonly Pick<CanvasEdge, 'from' | 'to'>[],
  byId: ReadonlyMap<string, Unit>,
): Unit[] {
  const along: Unit[] = []
  for (const edge of edges) {
    const otherId = otherEnd(edge, hub.rootId)
    if (otherId === undefined) continue
    const other = byId.get(otherId)
    if (other === undefined || other === hub) continue
    if (Math.abs(hub.bbox.y - other.bbox.y) >= TIDY_BAND_PX) continue
    along.push(other)
  }
  return along
}

/**
 * The partner `hub` should trade places with: the nearest of them, when
 * they ALL lie to one side — which is the condition that makes `hub` a hub
 * drawn at the end of its row. `undefined` when they straddle it (it is
 * already between them) or the nearest cannot move.
 */
function partnerToSwapWith(hub: Unit, along: readonly Unit[]): Unit | undefined {
  if (along.length < 2) return undefined
  const right = along.every((u) => u.bbox.x >= hub.bbox.x + hub.bbox.w)
  const left = along.every((u) => u.bbox.x + u.bbox.w <= hub.bbox.x)
  if (!right && !left) return undefined
  const nearest = along.reduce((best, u) =>
    Math.abs(u.bbox.x - hub.bbox.x) < Math.abs(best.bbox.x - hub.bbox.x) ? u : best,
  )
  return nearest.movable ? nearest : undefined
}

function orderRowsByEdges(units: Unit[], edges: readonly Pick<CanvasEdge, 'from' | 'to'>[]): void {
  const byId = soleBoxUnits(units)
  for (const hub of units) {
    if (!hub.movable || !byId.has(hub.rootId)) continue
    const partner = partnerToSwapWith(hub, partnersAlongRow(hub, edges, byId))
    if (partner === undefined) continue
    const hubX = hub.bbox.x
    AXIS_X.shift(hub, partner.bbox.x - hubX)
    AXIS_X.shift(partner, hubX - partner.bbox.x)
  }
}

/** How deep `unit` and `hit` overlap along `ax` — 0 or less when they miss. */
const penetration = (ax: Axis, unit: Rect, hit: Rect): number =>
  Math.min(ax.at(unit, 1), ax.at(hit, 1)) - Math.max(ax.near(unit), ax.near(hit))

/**
 * Hop `unit` clear of everything in `occupied`, one obstacle at a time, in
 * `dir` along `ax`. Monotone in one direction, so it terminates after at
 * most one hop per obstacle — the guard is a belt on that argument.
 */
function hopClear(unit: Unit, ax: Axis, dir: 1 | -1, occupied: readonly Rect[], from: number) {
  // Hops land ON the grid, rounding AWAY from the collider so the clearance
  // never shrinks — off-grid spots would feed the next pass's banding and
  // unsettle the fixpoint.
  const snapAway = (v: number) =>
    from +
    (dir === 1 ? Math.ceil((v - from) / TIDY_GRID_PX) : Math.floor((v - from) / TIDY_GRID_PX)) *
      TIDY_GRID_PX
  let guard = occupied.length + 1
  let hit = occupied.find((r) => overlapsWithMargin(unit.bbox, r))
  while (hit !== undefined && guard-- > 0) {
    const next = snapAway(
      dir === 1
        ? ax.at(hit, 1) + TIDY_MARGIN_PX
        : ax.near(hit) - TIDY_MARGIN_PX - ax.size(unit.bbox),
    )
    ax.shift(unit, next - ax.near(unit.bbox))
    hit = occupied.find((r) => overlapsWithMargin(unit.bbox, r))
  }
}

/**
 * Deterministic sequential placement: immobile units occupy first; each
 * movable unit then hops along ONE axis (chosen from its first collision:
 * smaller penetration wins, ties go horizontal; direction away from the
 * collider's centre, ties right/down) until clear of everything placed so
 * far.
 */
function resolveOverlaps(units: Unit[], origin: Point): void {
  const occupied: Rect[] = units.filter((u) => !u.movable).map((u) => u.bbox)
  for (const unit of units) {
    if (!unit.movable) continue
    const firstHit = occupied.find((r) => overlapsWithMargin(unit.bbox, r))
    if (firstHit !== undefined) {
      const ax =
        penetration(AXIS_X, unit.bbox, firstHit) <= penetration(AXIS_Y, unit.bbox, firstHit)
          ? AXIS_X
          : AXIS_Y
      const dir = ax.at(unit.bbox, 0.5) < ax.at(firstHit, 0.5) ? -1 : 1
      hopClear(unit, ax, dir, occupied, ax.of(origin))
    }
    occupied.push(unit.bbox)
  }
}

/**
 * An off-grid position is only earned while the neighbour it lines up with
 * is still there. This puts back the ones that are not.
 *
 * `alignBands` may leave a unit off the grid deliberately — lined up on a
 * neighbour's centre or far edge, which is what a reader calls aligned and
 * the grid cannot express. The passes above then run `resolveOverlaps`,
 * which can move THAT NEIGHBOUR, and the unit is left off-grid lined up
 * with nothing: an alignment to a box that is no longer where it was.
 *
 * `clearAfter` guards the neighbouring family and cannot see this one — it
 * asks whether the SNAPPED unit would overlap, and here it is the ANCHOR
 * that moves. The two are worth keeping apart: that guard prevents a bad
 * snap, this repairs a good snap whose reason expired.
 *
 * Measured on the counterexample the grid property found: a unit sat at
 * x=279 because a 140-wide neighbour at 240 ended at 380, and the overlap
 * pass then moved that neighbour to 256. The neighbour oscillates between
 * the two phases every pass, so the settle loop still reaches a repeated
 * state — idempotence held, and only the grid invariant broke, which is why
 * nothing else saw it.
 *
 * A snap that would put the unit inside a neighbour's margin is skipped, on
 * the same reasoning `clearAfter` uses: separation is a promise and the
 * grid is a preference.
 */
function snapStaleAnchors(units: Unit[], origin: Point): void {
  for (const unit of units) {
    if (!unit.movable) continue
    const others = units.filter((o) => o !== unit)
    // The same anchors `alignBands` aligns TO, read off where the units
    // actually ended up rather than from a second notion of "lined up".
    // The NEAR edge counts as lined up against any of a neighbour's three;
    // a centre or far edge only against the same anchor of one.
    const anchored = (ax: Axis): boolean =>
      others.some((o) =>
        ax.bandFractions.some((fraction) =>
          onSomeAnchor(
            ax.at(unit.bbox, fraction),
            fraction === 0
              ? [ax.at(o.bbox, 0), ax.at(o.bbox, 0.5), ax.at(o.bbox, 1)]
              : [ax.at(o.bbox, fraction)],
          ),
        ),
      )
    for (const ax of AXES) {
      const at = ax.near(unit.bbox)
      const snapped = roundToGrid(at, ax.of(origin))
      if (snapped === at || anchored(ax)) continue
      ax.shift(unit, snapped - at)
    }
  }
}

/**
 * Inside a frame: pull every movable unit onto the margin it starts at.
 *
 * An ANCHOR rather than only a floor — a member hugging the frame's top or
 * left edge is moved IN to it rather than the frame grown around it, and one
 * already clear of it but within `TIDY_BAND_PX` is pulled ONTO it. That is
 * what makes frames that line up hold members that line up: bands run among
 * a frame's members and among the frames, never across them.
 */
function applyFloor(
  units: Unit[],
  floor: Point,
  outside: { readonly x: readonly number[]; readonly y: readonly number[] },
): void {
  for (const unit of units) {
    if (!unit.movable) continue
    for (const ax of AXES) {
      const target = ax.of(floor)
      const at = ax.near(unit.bbox)
      if (at - target >= TIDY_BAND_PX) continue
      // Already lined up with something the frame does not hold: a
      // neighbour the margin rule cannot move IS the row, wherever it
      // sits, and that holds across a frame's edge as much as inside it.
      // Only the ANCHOR yields — a member outside the margin is still
      // moved in, which is the floor's own job and not an alignment.
      if (at >= target && onSomeAnchor(at, ax.of(outside))) continue
      ax.shift(unit, target - at)
    }
  }
}

/**
 * The smallest box holding `frame` and every rect with the margin around
 * it: growth only, so a frame drawn roomier than it needs stays as drawn.
 */
function enclosing(frame: Rect, rects: readonly Rect[]): Rect {
  const x = Math.min(frame.x, ...rects.map((r) => r.x - TIDY_MARGIN_PX))
  const y = Math.min(frame.y, ...rects.map((r) => r.y - TIDY_MARGIN_PX))
  const right = Math.max(frame.x + frame.w, ...rects.map((r) => r.x + r.w + TIDY_MARGIN_PX))
  const bottom = Math.max(frame.y + frame.h, ...rects.map((r) => r.y + r.h + TIDY_MARGIN_PX))
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * Tidy each frame's members inside it, and grow it to hold them.
 *
 * Runs ONCE, before the level's own passes. Running it inside the loop
 * instead was implemented and measured and did NOT pay: it settles more
 * boards in a single pass (400 of 20000 crowded generated boards still
 * needed a second, against 1394), and the second pass is cheaper than
 * doing this work every iteration — 1.6s against 2.4s over those 20000
 * boards, and 45ms against 56ms on a 300-box, 8-frame one, with the
 * output and every scoreboard column identical. What makes the leftovers
 * safe is `tidyNodes` settling to a fixpoint; this would only make them
 * rarer, for more work.
 *
 * Writes each member's settled rect into `settled`, and a frame that grew
 * carries its new box on its own unit too.
 */
/**
 * Where a frame's members lay their grid FROM.
 *
 * A frame that can MOVE lays it from its own corner, because the members it
 * carries have to stay where they are relative to it. One that cannot move
 * never carries anything, so it keeps the grid its level already has — and
 * its members stay on the board's, which is what a reader lines them up
 * against. (Nested: an immobile frame inside a movable one is carried, so it
 * inherits its level's origin rather than falling back to the board.)
 */
const innerOrigin = (unit: Unit, frame: Rect, levelOrigin: Point): Point =>
  unit.movable ? { x: frame.x, y: frame.y } : levelOrigin

/**
 * The margin a frame's members start at. On the frame's own grid the margin
 * is a whole number of steps, so this is `frame.{x,y} + TIDY_MARGIN_PX`
 * exactly — written through the same helper because that is what makes it
 * true rather than a coincidence of today's two constants.
 */
const innerFloor = (frame: Rect): Point => ({
  x: ceilToGrid(frame.x + TIDY_MARGIN_PX, frame.x),
  y: ceilToGrid(frame.y + TIDY_MARGIN_PX, frame.y),
})

/**
 * Who this level's frame pass may move and grow. One bundle because both
 * answers are read off the same two options and the same membership set.
 */
interface FramePolicy {
  /**
   * Whether a frame may grow to hold its members: it is unlocked, and it or
   * one of them is in scope.
   */
  readonly grows: (unit: Unit, inner: readonly TidyNode[]) => boolean
  /**
   * Whether the MARGIN rule can move this id. It reaches a frame's members
   * and nobody else, so a box at this level that no frame holds keeps its
   * row — and the margin anchor yields to it.
   */
  readonly marginCanMove: (id: string) => boolean
}

function framePolicyFor(units: readonly Unit[], options: TidyOptions): FramePolicy {
  const locked = options.locked ?? (() => false)
  const inScope = (id: string) => options.scope === undefined || options.scope.has(id)
  const framed = new Set(
    units.flatMap((u) => (u.members.length > 1 ? u.members.map((m) => m.id) : [])),
  )
  return {
    grows: (unit, inner) =>
      !locked(unit.rootId) && (inScope(unit.rootId) || inner.some((m) => inScope(m.id))),
    marginCanMove: (id) => inScope(id) && !locked(id) && framed.has(id),
  }
}

function tidyInsideFrames(
  units: readonly Unit[],
  nodes: readonly TidyNode[],
  options: TidyOptions,
  origin: Point,
  settled: Map<string, Rect>,
): void {
  const policy = framePolicyFor(units, options)
  for (const unit of units) {
    const inner = unit.members.filter((m) => m.id !== unit.rootId)
    if (inner.length === 0) continue
    const frame = settled.get(unit.rootId)
    if (frame === undefined) continue
    const innerSettled = tidyLevel(
      inner,
      options,
      anchorsToYieldTo(nodes, new Set(inner.map((m) => m.id)), policy.marginCanMove),
      innerOrigin(unit, frame, origin),
      innerFloor(frame),
    )
    for (const [id, rect] of innerSettled) settled.set(id, rect)
    if (!policy.grows(unit, inner)) continue
    const grown = enclosing(frame, [...innerSettled.values()])
    settled.set(unit.rootId, grown)
    unit.bbox = { ...grown }
  }
}

/**
 * Run the alignment, ordering and separation passes to an internal FIXPOINT
 * (bounded). An overlap hop can
 * land a unit near a band boundary and vice versa, so a single sweep is
 * not always stable. Iterating until nothing moves makes tidy's output
 * its own fixpoint — which is exactly what the idempotence property
 * requires: a second tidy starts at a fixpoint and moves nothing.
 *
 * Stopping at a state SEEN BEFORE, rather than only at one equal to the
 * previous state, is what makes that hold when the passes CYCLE instead
 * of settling — a band snap that the overlap pass undoes and the next
 * band snap redoes elsewhere. A cycle has no fixpoint to reach, so the
 * old test stopped at the iteration cap, mid-cycle, at whichever state
 * the parity of the cap happened to land on; a second tidy resumed the
 * cycle and moved the nodes again. Returning the first REPEATED state
 * instead returns a state that lies on the cycle, so re-entering from it
 * walks the same loop and stops on the same state — idempotent by the
 * same argument, without either state being a fixpoint of the passes.
 */
function runPassesToFixpoint(
  units: Unit[],
  options: TidyOptions,
  origin: Point,
  floor: Point | undefined,
): void {
  const signature = () => units.map((u) => `${u.bbox.x} ${u.bbox.y}`).join('|')
  const seen = new Set<string>([signature()])
  const TIDY_MAX_ITERATIONS = 8
  for (let i = 0; i < TIDY_MAX_ITERATIONS; i++) {
    alignBands(units, AXIS_X, origin.x, floor?.x)
    alignBands(units, AXIS_Y, origin.y, floor?.y)
    if (options.edges !== undefined) orderRowsByEdges(units, options.edges)
    resolveOverlaps(units, origin)
    const now = signature()
    if (seen.has(now)) break
    seen.add(now)
  }
}

/** Carry each unit's accumulated delta onto every member it moves. */
function applyUnitDeltas(units: readonly Unit[], settled: Map<string, Rect>): void {
  for (const unit of units) {
    if (!unit.movable || (unit.dx === 0 && unit.dy === 0)) continue
    for (const id of unit.movableIds) {
      const rect = settled.get(id)
      if (rect === undefined) continue
      settled.set(id, { ...rect, x: rect.x + unit.dx, y: rect.y + unit.dy })
    }
  }
}

/**
 * One level of the tidy: every node's settled rect, frames tidied inside
 * (recursively) and grown before the level's own units align and separate.
 */
function tidyLevel(
  nodes: readonly TidyNode[],
  options: TidyOptions,
  // The anchors of what this level's frame does not hold and the margin
  // rule cannot move, for the margin snap to yield to. Empty at the top
  // level, which has no frame around it.
  outside: { readonly x: readonly number[]; readonly y: readonly number[] },
  // Where this level's grid is laid FROM: the board's zero at the top
  // level, a frame's own corner inside one (see `roundToGrid`).
  origin: Point,
  // Inside a frame: the margin its members start at, as an ANCHOR rather
  // than only a floor. A member hugging the frame's top or left edge is
  // moved in to it rather than the frame grown around it — the frame's
  // top-left is its anchor and its alignment with its peers, and stays put;
  // only an immobile member can push a frame up or left. A member already
  // clear of it but within `TIDY_BAND_PX` is pulled ONTO it, which is what
  // makes frames that line up hold members that line up: bands run among a
  // frame's members and among the frames, never across them, so nothing
  // else can see that a member at 32 in one frame and one at 40 in another
  // are a column to a reader. Superseding an earlier decision that a frame
  // padded to more than the margin was padded and tidy left it alone (user,
  // 2026-09-10): it costs 8px of movement on a board already fine, and buys
  // the alignment no band reaches.
  floor?: Point,
): Map<string, Rect> {
  const units = buildUnits(nodes, options)
  const settled = new Map<string, Rect>(nodes.map((n) => [n.id, rectOf(n)]))
  tidyInsideFrames(units, nodes, options, origin, settled)
  if (floor !== undefined) applyFloor(units, floor, outside)
  runPassesToFixpoint(units, options, origin, floor)
  snapStaleAnchors(units, origin)
  applyUnitDeltas(units, settled)
  return settled
}

/** Rounded, because that is the state a caller applies and re-enters with. */
function settleOnce(nodes: readonly TidyNode[], options: TidyOptions): TidyNode[] {
  const settled = tidyLevel(nodes, options, { x: [], y: [] }, { x: 0, y: 0 })
  return nodes.map((node) => {
    const rect = settled.get(node.id)
    if (rect === undefined) return node
    const next = {
      ...node,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.w),
      height: Math.round(rect.h),
    }
    return [next.x, next.y, next.width, next.height].every(Number.isFinite) ? next : node
  })
}

/**
 * Tidy SETTLES: it returns a state it would not move again, by checking.
 *
 * Every rule below this line is local — a band, a hop, a margin, a frame
 * growing — and idempotence is a property of all of them together, which no
 * one of them can be responsible for. Two fixes each closed a family and
 * left a smaller one; the rest is not a family at all, it is the tail of a
 * fixpoint nobody was computing.
 *
 * So the entry point computes it. It settles, re-enters, and stops when the
 * state repeats — stopping at a state already SEEN rather than at one that
 * stopped moving, for the reason the level's own loop does: the passes can
 * CYCLE, and a repeated state is the one re-entry reproduces. Six boards in
 * 40000 do exactly that, so this is not a theoretical case.
 *
 * The cost is one confirming pass on a board that was already settled,
 * which is what most are: measured 19ms -> 45ms on a 300-box, 8-frame
 * board. A tap can pay that; a caller who could not is `layoutSpatialEdges`,
 * and tidy is not on its path.
 *
 * The CEILING is a measurement, not a guess. Over 40000 boards drawn the way
 * the property draws them — one or two frames, a lock always, a partial
 * scope half the time — reaching a repeated state took 2 passes on 34885 of
 * them, 3 on 4759, and 7 at the worst. A ceiling of 4 shipped, and CI's
 * stress lane found the board that needs 5 within the hour: a locked frame
 * overlapping a scoped one, where each pass moved a member the next pass had
 * to grow the frame around.
 */
const TIDY_MAX_SETTLE_PASSES = 12

export function tidyNodes(
  nodes: readonly TidyNode[],
  options: TidyOptions = {},
): readonly TidyMove[] {
  const clean = usable(nodes)
  if (clean.length < 2) return []
  const positions = (ns: readonly TidyNode[]) =>
    ns.map((n) => `${n.x} ${n.y} ${n.width} ${n.height}`).join('|')
  let current = clean
  const seen = new Set<string>()
  for (let i = 0; i < TIDY_MAX_SETTLE_PASSES; i++) {
    seen.add(positions(current))
    current = settleOnce(current, options)
    if (seen.has(positions(current))) break
  }
  const settled = new Map(current.map((n) => [n.id, { x: n.x, y: n.y, w: n.width, h: n.height }]))
  const moves: TidyMove[] = []
  for (const node of clean) {
    const rect = settled.get(node.id)
    if (rect === undefined) continue
    const x = Math.round(rect.x)
    const y = Math.round(rect.y)
    const width = Math.round(rect.w)
    const height = Math.round(rect.h)
    // Defensive twin of the workspace write guard: tidy must
    // never emit a position the doc layer would refuse.
    if (![x, y, width, height].every(Number.isFinite)) continue
    const grew = width !== node.width || height !== node.height
    if (x === node.x && y === node.y && !grew) continue
    moves.push(grew ? { id: node.id, x, y, width, height } : { id: node.id, x, y })
  }
  return moves
}
