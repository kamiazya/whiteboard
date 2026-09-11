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
import { endpointNode } from '@kamiazya/whiteboard-model'
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

export interface TidyMove {
  readonly id: string
  readonly x: number
  readonly y: number
  /** Present only on a frame that grew to hold its members. */
  readonly width?: number
  readonly height?: number
}

/**
 * The grid is laid from an ORIGIN, which inside a frame is the frame's own
 * corner rather than the board's zero.
 *
 * A frame is snapped to the board's grid like anything else, so it moves by
 * whatever it was off by — and every member placed against the board's grid
 * before that move is carried the same distance OFF it. The next tidy put
 * them back, which is what made tidy non-idempotent on any board holding a
 * frame drawn off the grid (2446 of 3000 generated boards). Laid from the
 * frame's corner instead, a member's position is a fact about the frame,
 * and moving the frame carries it and its grid together.
 *
 * The visible cost, stated because a reader will find it: a member of an
 * off-grid frame is off the BOARD's grid by the frame's own offset. That is
 * the frame's alignment to answer for, and it is answered — the frame
 * itself takes the board's grid — where a member 3px off the row inside its
 * own frame answers for nothing.
 */
const roundToGrid = (v: number, origin = 0) =>
  origin + Math.round((v - origin) / TIDY_GRID_PX) * TIDY_GRID_PX
const ceilToGrid = (v: number, origin = 0) =>
  origin + Math.ceil((v - origin) / TIDY_GRID_PX) * TIDY_GRID_PX

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

const onSomeAnchor = (value: number, anchors: readonly number[]): boolean =>
  anchors.some((anchor) => Math.abs(anchor - value) <= 0.5)

/**
 * Banded alignment along one axis, by each anchor a drawer sets: the near
 * edge, then the centre, then on x the far edge — a width is named, a
 * height is usually fitted to the text. A unit lined up by an earlier
 * anchor is that band's truth for the later ones and does not move again;
 * a unit alone at its edge may still be centred under a wider neighbour,
 * which a reader calls lined up and an edge band could never see. Units
 * in no band at all take the grid at their edge.
 */
function alignBands(units: Unit[], axis: 'x' | 'y', origin: number, floor?: number): void {
  const edge = (u: Unit) => (axis === 'x' ? u.bbox.x : u.bbox.y)
  const extent = (u: Unit) => (axis === 'x' ? u.bbox.w : u.bbox.h)
  const shift = (unit: Unit, delta: number) => {
    if (delta === 0) return
    if (axis === 'x') {
      unit.bbox.x += delta
      unit.dx += delta
    } else {
      unit.bbox.y += delta
      unit.dy += delta
    }
  }
  // A centre or far-edge snap is cosmetic and separation is not, so one
  // that would put a unit inside a neighbour's margin yields. Without this
  // the fixpoint loop drifts: the snap jams the unit, the overlap pass hops
  // it away, and the next iteration snaps it back — an edge band can never
  // do that, since a hop carries a unit out of its own band's reach, but a
  // band measured against a third unit can.
  const clearAfter = (unit: Unit, delta: number): boolean => {
    const moved =
      axis === 'x'
        ? { ...unit.bbox, x: unit.bbox.x + delta }
        : { ...unit.bbox, y: unit.bbox.y + delta }
    return units.every((other) => other === unit || !overlapsWithMargin(moved, other.bbox))
  }
  /**
   * Inside a frame, a band may not push a unit back OUT past the margin.
   *
   * The floor runs once, before these passes, so without this a band undoes
   * it — and that is not merely cosmetic, it is what made tidy grow a frame
   * for ever. Measured: a far-edge band snapped one member's left edge to
   * the grid, dragged its row-mate 3px left of the margin, the frame grew to
   * hold the escapee, and the level's own snap then carried the whole unit
   * back — 3px wider on every tidy, with no member moving at all.
   *
   * Applying the floor again AFTER the passes was tried instead and is worse
   * than the bug: the overlap pass no longer gets the last word, and the
   * grouped corpus went from 0 overlapping pairs to 109.
   */
  const insideMargin = (unit: Unit, delta: number): boolean =>
    floor === undefined || edge(unit) + delta >= floor - 0.5

  const lined = new Set<Unit>()
  for (const fraction of axis === 'x' ? [0, 0.5, 1] : [0, 0.5]) {
    const anchor = (u: Unit) => edge(u) + extent(u) * fraction
    const guarded = fraction !== 0
    for (const band of bandsBy(units, anchor)) {
      if (band.length < 2) continue
      // An immobile member is the band's truth, and so is one an earlier
      // anchor lined up: a movable one snaps onto it exactly, grid or no
      // grid, since the grid cannot move that neighbour and a 4px miss
      // reads as a row drawn carelessly. A band free to move as a whole
      // puts its first member's edge on the grid and follows it.
      const fixed = band.find((u) => !u.movable || lined.has(u))
      const first = band[0] as Unit
      // A partner inside a neighbour's margin is about to be hopped away by
      // the overlap pass, and a unit lined up to it this iteration would be
      // left off the grid, lined up with nothing. So a centre or far-edge
      // band follows only a partner that is standing still.
      const partner = fixed ?? first
      if (guarded && !clearAfter(partner, 0)) continue
      if (fixed === undefined) {
        const toGrid = roundToGrid(edge(first), origin) - edge(first)
        if ((!guarded || clearAfter(first, toGrid)) && insideMargin(first, toGrid)) {
          shift(first, toGrid)
        }
      }
      const target = anchor(partner)
      for (const unit of band) {
        if (!unit.movable || lined.has(unit)) continue
        // A centre between a box of each parity is a half pixel; the edge
        // takes the whole pixel nearest, since the output is rounded and a
        // snap the rounding undoes is not a snap.
        const delta = Math.round(edge(unit) + target - anchor(unit)) - edge(unit)
        if (guarded && delta !== 0 && !clearAfter(unit, delta)) continue
        if (!insideMargin(unit, delta)) continue
        shift(unit, delta)
      }
      // Lined up means sharing the anchor with SOMETHING, to the half pixel
      // parity allows: a band whose every other snap yielded leaves its
      // first member alone, and alone it takes the grid below like any other.
      const atTarget = band.filter((u) => Math.abs(anchor(u) - target) <= 0.5)
      if (atTarget.length >= 2) for (const unit of atTarget) lined.add(unit)
    }
  }
  for (const unit of units) {
    if (!unit.movable || lined.has(unit)) continue
    const toGrid = roundToGrid(edge(unit), origin) - edge(unit)
    if (insideMargin(unit, toGrid)) shift(unit, toGrid)
  }
}

/**
 * Bands by the fixed first anchor — never a running mean — which is what
 * stops transitive chaining (A near B, C near B's new spot) from dragging a
 * whole diagonal into one line. STRICT inequality: consecutive band targets
 * are >= one band apart (multiples of the grid), so a snapped unit sitting
 * exactly one band from a neighbour must not re-join it on a later pass.
 */
function bandsBy(units: Unit[], anchor: (u: Unit) => number): Unit[][] {
  const sorted = [...units].sort((a, b) => anchor(a) - anchor(b))
  const bands: Unit[][] = []
  let band: Unit[] = []
  let bandFirst = 0
  for (const unit of sorted) {
    if (band.length === 0 || anchor(unit) - bandFirst >= TIDY_BAND_PX) {
      if (band.length > 0) bands.push(band)
      band = []
      bandFirst = anchor(unit)
    }
    band.push(unit)
  }
  if (band.length > 0) bands.push(band)
  return bands
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
function orderRowsByEdges(units: Unit[], edges: readonly Pick<CanvasEdge, 'from' | 'to'>[]): void {
  const unitOf = new Map<string, Unit>()
  for (const unit of units) {
    if (unit.members.length === 1 && unit.members[0]?.type !== 'group') {
      unitOf.set(unit.rootId, unit)
    }
  }
  const sameRow = (a: Unit, b: Unit) => Math.abs(a.bbox.y - b.bbox.y) < TIDY_BAND_PX
  for (const hub of units) {
    if (!hub.movable || !unitOf.has(hub.rootId)) continue
    const along: Unit[] = []
    for (const edge of edges) {
      const otherId =
        endpointNode(edge.from) === hub.rootId
          ? endpointNode(edge.to)
          : endpointNode(edge.to) === hub.rootId
            ? endpointNode(edge.from)
            : undefined
      if (otherId === undefined) continue
      const other = unitOf.get(otherId)
      if (other === undefined || other === hub || !sameRow(hub, other)) continue
      along.push(other)
    }
    if (along.length < 2) continue
    const right = along.every((u) => u.bbox.x >= hub.bbox.x + hub.bbox.w)
    const left = along.every((u) => u.bbox.x + u.bbox.w <= hub.bbox.x)
    if (!right && !left) continue
    const nearest = along.reduce((best, u) =>
      Math.abs(u.bbox.x - hub.bbox.x) < Math.abs(best.bbox.x - hub.bbox.x) ? u : best,
    )
    if (!nearest.movable) continue
    const hubX = hub.bbox.x
    const nearX = nearest.bbox.x
    hub.dx += nearX - hubX
    hub.bbox.x = nearX
    nearest.dx += hubX - nearX
    nearest.bbox.x = hubX
  }
}

/**
 * Deterministic sequential placement: immobile units occupy first; each
 * movable unit then hops along ONE axis (chosen from its first collision:
 * smaller penetration wins, ties go horizontal; direction away from the
 * collider's centre, ties right/down) until clear of everything placed so
 * far. Monotone in one direction, so it terminates after at most one hop
 * per obstacle.
 */
function resolveOverlaps(units: Unit[], origin: Point): void {
  const occupied: Rect[] = units.filter((u) => !u.movable).map((u) => u.bbox)
  for (const unit of units) {
    if (!unit.movable) continue
    const firstHit = occupied.find((r) => overlapsWithMargin(unit.bbox, r))
    if (firstHit !== undefined) {
      const penX =
        Math.min(unit.bbox.x + unit.bbox.w, firstHit.x + firstHit.w) -
        Math.max(unit.bbox.x, firstHit.x)
      const penY =
        Math.min(unit.bbox.y + unit.bbox.h, firstHit.y + firstHit.h) -
        Math.max(unit.bbox.y, firstHit.y)
      const axis: 'x' | 'y' = penX <= penY ? 'x' : 'y'
      const unitCenter =
        axis === 'x' ? unit.bbox.x + unit.bbox.w / 2 : unit.bbox.y + unit.bbox.h / 2
      const hitCenter = axis === 'x' ? firstHit.x + firstHit.w / 2 : firstHit.y + firstHit.h / 2
      const dir = unitCenter < hitCenter ? -1 : 1
      let guard = occupied.length + 1
      let hit: Rect | undefined = firstHit
      while (hit !== undefined && guard-- > 0) {
        // Hops land ON the grid, rounding AWAY from the collider so the
        // clearance never shrinks — off-grid spots would feed the next
        // pass's banding and unsettle the fixpoint.
        const from = axis === 'x' ? origin.x : origin.y
        const snapAway = (v: number) =>
          from +
          (dir === 1
            ? Math.ceil((v - from) / TIDY_GRID_PX)
            : Math.floor((v - from) / TIDY_GRID_PX)) *
            TIDY_GRID_PX
        const next =
          axis === 'x'
            ? dir === 1
              ? snapAway(hit.x + hit.w + TIDY_MARGIN_PX)
              : snapAway(hit.x - TIDY_MARGIN_PX - unit.bbox.w)
            : dir === 1
              ? snapAway(hit.y + hit.h + TIDY_MARGIN_PX)
              : snapAway(hit.y - TIDY_MARGIN_PX - unit.bbox.h)
        if (axis === 'x') {
          unit.dx += next - unit.bbox.x
          unit.bbox.x = next
        } else {
          unit.dy += next - unit.bbox.y
          unit.bbox.y = next
        }
        hit = occupied.find((r) => overlapsWithMargin(unit.bbox, r))
      }
    }
    occupied.push(unit.bbox)
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
  const locked = options.locked ?? (() => false)
  const inScope = (id: string) => options.scope === undefined || options.scope.has(id)
  const units = buildUnits(nodes, options)
  // Who the margin rule can reach at all: a frame's members, and nobody
  // else. A box at this level that no frame holds keeps its row.
  const framed = new Set(
    units.flatMap((u) => (u.members.length > 1 ? u.members.map((m) => m.id) : [])),
  )
  const settled = new Map<string, Rect>(nodes.map((n) => [n.id, rectOf(n)]))
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
   * safe is `tidyNodes` settling to a fixpoint, below; this would only make
   * them rarer, for more work.
   */
  for (const unit of units) {
    const inner = unit.members.filter((m) => m.id !== unit.rootId)
    if (inner.length === 0) continue
    const frame = settled.get(unit.rootId)
    if (frame === undefined) continue
    const innerSettled = tidyLevel(
      inner,
      options,
      anchorsToYieldTo(
        nodes,
        new Set(inner.map((m) => m.id)),
        (id) => inScope(id) && !locked(id) && framed.has(id),
      ),
      // A frame that can MOVE lays the grid from its own corner, because the
      // members it carries have to stay where they are relative to it. One
      // that cannot move never carries anything, so it keeps the grid its
      // level already has — and its members stay on the board's, which is
      // what a reader lines them up against. (Nested: an immobile frame
      // inside a movable one is carried, so it inherits its level's origin
      // rather than falling back to the board.)
      unit.movable ? { x: frame.x, y: frame.y } : origin,
      {
        // On the frame's own grid the margin is a whole number of steps, so
        // this is `frame.{x,y} + TIDY_MARGIN_PX` exactly. Written through
        // the same helper because that is what makes it true rather than a
        // coincidence of today's two constants.
        x: ceilToGrid(frame.x + TIDY_MARGIN_PX, frame.x),
        y: ceilToGrid(frame.y + TIDY_MARGIN_PX, frame.y),
      },
    )
    for (const [id, rect] of innerSettled) settled.set(id, rect)
    const grows = !locked(unit.rootId) && (inScope(unit.rootId) || inner.some((m) => inScope(m.id)))
    if (!grows) continue
    const grown = enclosing(frame, [...innerSettled.values()])
    settled.set(unit.rootId, grown)
    unit.bbox = { ...grown }
  }
  const applyFloor = () => {
    if (floor === undefined) return
    for (const unit of units) {
      if (!unit.movable) continue
      for (const axis of ['x', 'y'] as const) {
        const target = axis === 'x' ? floor.x : floor.y
        const at = axis === 'x' ? unit.bbox.x : unit.bbox.y
        if (at - target >= TIDY_BAND_PX) continue
        // Already lined up with something the frame does not hold: a
        // neighbour the margin rule cannot move IS the row, wherever it
        // sits, and that holds across a frame's edge as much as inside it.
        // Only the ANCHOR yields — a member outside the margin is still
        // moved in, which is the floor's own job and not an alignment.
        if (at >= target && onSomeAnchor(at, axis === 'x' ? outside.x : outside.y)) continue
        if (axis === 'x') {
          unit.dx += target - unit.bbox.x
          unit.bbox.x = target
        } else {
          unit.dy += target - unit.bbox.y
          unit.bbox.y = target
        }
      }
    }
  }
  applyFloor()
  // Run the passes to an internal FIXPOINT (bounded): an overlap hop can
  // land a unit near a band boundary and vice versa, so a single sweep is
  // not always stable. Iterating until nothing moves makes tidy's output
  // its own fixpoint — which is exactly what the idempotence property
  // requires: a second tidy starts at a fixpoint and moves nothing.
  //
  // Stopping at a state SEEN BEFORE, rather than only at one equal to the
  // previous state, is what makes that hold when the passes CYCLE instead
  // of settling — a band snap that the overlap pass undoes and the next
  // band snap redoes elsewhere. A cycle has no fixpoint to reach, so the
  // old test stopped at the iteration cap, mid-cycle, at whichever state
  // the parity of the cap happened to land on; a second tidy resumed the
  // cycle and moved the nodes again. Returning the first REPEATED state
  // instead returns a state that lies on the cycle, so re-entering from it
  // walks the same loop and stops on the same state — idempotent by the
  // same argument, without either state being a fixpoint of the passes.
  const signature = () => units.map((u) => `${u.bbox.x} ${u.bbox.y}`).join('|')
  const seen = new Set<string>([signature()])
  const TIDY_MAX_ITERATIONS = 8
  for (let i = 0; i < TIDY_MAX_ITERATIONS; i++) {
    alignBands(units, 'x', origin.x, floor?.x)
    alignBands(units, 'y', origin.y, floor?.y)
    if (options.edges !== undefined) orderRowsByEdges(units, options.edges)
    resolveOverlaps(units, origin)
    const now = signature()
    if (seen.has(now)) break
    seen.add(now)
  }
  for (const unit of units) {
    if (!unit.movable || (unit.dx === 0 && unit.dy === 0)) continue
    for (const id of unit.movableIds) {
      const rect = settled.get(id)
      if (rect === undefined) continue
      settled.set(id, { ...rect, x: rect.x + unit.dx, y: rect.y + unit.dy })
    }
  }
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
