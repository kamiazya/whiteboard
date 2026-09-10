/**
 * One-tap tidy: deterministic normalization that respects the author's
 * rough topology instead of re-laying the canvas out wholesale.
 *
 * Three passes over UNITS (an outermost group and everything its box
 * contains move as one; every other node is its own unit), applied INSIDE
 * each frame first and then at the level of the frames themselves:
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
 * 2. Overlap resolution as a deterministic sequential PLACEMENT: units in
 *    document order claim their spot; a unit overlapping anything already
 *    placed (or any immobile unit) hops along one axis — chosen once from
 *    its first collision — until clear by `TIDY_MARGIN_PX`. Because every
 *    processed unit ends fully clear of everything before it, a second
 *    tidy has nothing to do: idempotence holds by construction (and is
 *    pinned by a property test).
 * 3. Edge legibility is deliberately NOT tidy's job — once nodes settle,
 *    the edge optimizer re-routes and re-sides edges on the
 *    committed render.
 *
 * Pure and total: returns ONLY the boxes that actually move (a frame that
 * grew carries its new size); degenerate input never throws. Locked nodes
 * never move and stand as fixed obstacles, and a frame holding one is held
 * by it (moving the frame would carry it away from a member that cannot
 * follow); out-of-scope units likewise.
 */
export interface TidyMove {
  readonly id: string
  readonly x: number
  readonly y: number
  /** Present only on a frame that grew to hold its members. */
  readonly width?: number
  readonly height?: number
}

export interface TidyNode {
  readonly id: string
  readonly type: 'text' | 'file' | 'link' | 'group'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface TidyOptions {
  /** Unit roots outside this set stay put (undefined = whole canvas). */
  readonly scope?: ReadonlySet<string>
  readonly locked?: (id: string) => boolean
}

const TIDY_BAND_PX = 24
const TIDY_GRID_PX = 8
const TIDY_MARGIN_PX = 32
/**
 * Best-effort ceiling: movable units beyond this stay put (the rest of
 * the tidy still applies). Same class of bound as the edge optimizer's
 * CROSSING_OPT_MAX_EDGES — this runs on a phone.
 */
const TIDY_MAX_UNITS = 300

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Point {
  readonly x: number
  readonly y: number
}

interface Unit {
  readonly rootId: string
  /** Every node of the unit, the root included. */
  readonly members: readonly TidyNode[]
  /** Member node ids that move with the unit (locked members excluded). */
  readonly movableIds: readonly string[]
  bbox: Rect
  readonly movable: boolean
  dx: number
  dy: number
}

const roundToGrid = (v: number) => Math.round(v / TIDY_GRID_PX) * TIDY_GRID_PX
const ceilToGrid = (v: number) => Math.ceil(v / TIDY_GRID_PX) * TIDY_GRID_PX

function fullyContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

function overlapsWithMargin(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w + TIDY_MARGIN_PX &&
    b.x < a.x + a.w + TIDY_MARGIN_PX &&
    a.y < b.y + b.h + TIDY_MARGIN_PX &&
    b.y < a.y + a.h + TIDY_MARGIN_PX
  )
}

const rectOf = (n: TidyNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height })

function usable(nodes: readonly TidyNode[]): TidyNode[] {
  return nodes.filter(
    (n) =>
      Number.isFinite(n.x) &&
      Number.isFinite(n.y) &&
      Number.isFinite(n.width) &&
      Number.isFinite(n.height),
  )
}

/**
 * Outermost-rooted single-scoop units: a group is a unit root iff no other
 * group's box fully contains it (identical boxes tie-break to the earlier
 * document index); each root claims every yet-unclaimed node its box
 * contains in ONE flat scoop, so nested groups and their members can never
 * be double-assigned. Everything else is a singleton unit.
 */
function buildUnits(nodes: readonly TidyNode[], options: TidyOptions): Unit[] {
  const locked = options.locked ?? (() => false)
  const inScope = (id: string) => options.scope === undefined || options.scope.has(id)
  const groups = nodes.filter((n) => n.type === 'group')
  const isRoot = (g: TidyNode, index: number) =>
    !groups.some(
      (h, hIndex) =>
        h.id !== g.id &&
        fullyContains(rectOf(h), rectOf(g)) &&
        (!fullyContains(rectOf(g), rectOf(h)) || hIndex < index),
    )
  const claimed = new Set<string>()
  const units: Unit[] = []
  let movableCount = 0
  const pushUnit = (rootId: string, memberNodes: readonly TidyNode[], bbox: Rect) => {
    // A frame holding a locked member is held by it: moving the unit would
    // carry the frame away from a member that cannot follow.
    const movable =
      inScope(rootId) &&
      !locked(rootId) &&
      !memberNodes.some((m) => locked(m.id)) &&
      movableCount < TIDY_MAX_UNITS
    if (movable) movableCount++
    units.push({
      rootId,
      members: memberNodes,
      movableIds: memberNodes.filter((m) => !locked(m.id)).map((m) => m.id),
      bbox: { ...bbox },
      movable,
      dx: 0,
      dy: 0,
    })
  }
  for (const [index, node] of nodes.entries()) {
    if (claimed.has(node.id)) continue
    if (node.type === 'group' && isRoot(node, groups.indexOf(node))) {
      void index
      const members = nodes.filter(
        (m) => !claimed.has(m.id) && (m.id === node.id || fullyContains(rectOf(node), rectOf(m))),
      )
      for (const m of members) claimed.add(m.id)
      pushUnit(node.id, members, rectOf(node))
    }
  }
  for (const node of nodes) {
    if (claimed.has(node.id)) continue
    claimed.add(node.id)
    pushUnit(node.id, [node], rectOf(node))
  }
  // Units participate in document order of their root — rebuild that order
  // (group roots were emitted before later singletons above).
  const orderOf = new Map(nodes.map((n, i) => [n.id, i]))
  units.sort((a, b) => (orderOf.get(a.rootId) ?? 0) - (orderOf.get(b.rootId) ?? 0))
  return units
}

/**
 * Banded alignment along one axis, by each anchor a drawer sets: the near
 * edge, then the centre, then on x the far edge — a width is named, a
 * height is usually fitted to the text. A unit lined up by an earlier
 * anchor is that band's truth for the later ones and does not move again;
 * a unit alone at its edge may still be centred under a wider neighbour,
 * which a reader calls lined up and an edge band could never see. Units
 * in no band at all take the grid at their edge.
 */
function alignBands(units: Unit[], axis: 'x' | 'y'): void {
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
        const toGrid = roundToGrid(edge(first)) - edge(first)
        if (!guarded || clearAfter(first, toGrid)) shift(first, toGrid)
      }
      const target = anchor(partner)
      for (const unit of band) {
        if (!unit.movable || lined.has(unit)) continue
        // A centre between a box of each parity is a half pixel; the edge
        // takes the whole pixel nearest, since the output is rounded and a
        // snap the rounding undoes is not a snap.
        const delta = Math.round(edge(unit) + target - anchor(unit)) - edge(unit)
        if (guarded && delta !== 0 && !clearAfter(unit, delta)) continue
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
    shift(unit, roundToGrid(edge(unit)) - edge(unit))
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
 * Deterministic sequential placement: immobile units occupy first; each
 * movable unit then hops along ONE axis (chosen from its first collision:
 * smaller penetration wins, ties go horizontal; direction away from the
 * collider's centre, ties right/down) until clear of everything placed so
 * far. Monotone in one direction, so it terminates after at most one hop
 * per obstacle.
 */
function resolveOverlaps(units: Unit[]): void {
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
        const snapAway = (v: number) =>
          dir === 1
            ? Math.ceil(v / TIDY_GRID_PX) * TIDY_GRID_PX
            : Math.floor(v / TIDY_GRID_PX) * TIDY_GRID_PX
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
  // Inside a frame: the least x and y a movable unit may keep, so a member
  // hugging the frame's top or left edge is moved in to the margin rather
  // than the frame grown around it — the frame's top-left is its anchor
  // and its alignment with its peers, and stays put. Only an immobile
  // member can push a frame up or left.
  floor?: Point,
): Map<string, Rect> {
  const locked = options.locked ?? (() => false)
  const inScope = (id: string) => options.scope === undefined || options.scope.has(id)
  const units = buildUnits(nodes, options)
  const settled = new Map<string, Rect>(nodes.map((n) => [n.id, rectOf(n)]))
  for (const unit of units) {
    const inner = unit.members.filter((m) => m.id !== unit.rootId)
    if (inner.length === 0) continue
    const frame = settled.get(unit.rootId)
    if (frame === undefined) continue
    const innerSettled = tidyLevel(inner, options, {
      x: ceilToGrid(frame.x + TIDY_MARGIN_PX),
      y: ceilToGrid(frame.y + TIDY_MARGIN_PX),
    })
    for (const [id, rect] of innerSettled) settled.set(id, rect)
    const grows = !locked(unit.rootId) && (inScope(unit.rootId) || inner.some((m) => inScope(m.id)))
    if (!grows) continue
    const grown = enclosing(frame, [...innerSettled.values()])
    settled.set(unit.rootId, grown)
    unit.bbox = { ...grown }
  }
  if (floor !== undefined) {
    for (const unit of units) {
      if (!unit.movable) continue
      if (unit.bbox.x < floor.x) {
        unit.dx += floor.x - unit.bbox.x
        unit.bbox.x = floor.x
      }
      if (unit.bbox.y < floor.y) {
        unit.dy += floor.y - unit.bbox.y
        unit.bbox.y = floor.y
      }
    }
  }
  // Run the passes to an internal FIXPOINT (bounded): an overlap hop can
  // land a unit near a band boundary and vice versa, so a single sweep is
  // not always stable. Iterating until nothing moves makes tidy's output
  // its own fixpoint — which is exactly what the idempotence property
  // requires: a second tidy starts at a fixpoint and moves nothing.
  const TIDY_MAX_ITERATIONS = 8
  for (let i = 0; i < TIDY_MAX_ITERATIONS; i++) {
    const before = units.map((u) => `${u.bbox.x} ${u.bbox.y}`).join('|')
    alignBands(units, 'x')
    alignBands(units, 'y')
    resolveOverlaps(units)
    if (units.map((u) => `${u.bbox.x} ${u.bbox.y}`).join('|') === before) break
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

export function tidyNodes(
  nodes: readonly TidyNode[],
  options: TidyOptions = {},
): readonly TidyMove[] {
  const clean = usable(nodes)
  if (clean.length < 2) return []
  const settled = tidyLevel(clean, options)
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
