/**
 * One-tap tidy: deterministic normalization that respects the author's
 * rough topology instead of re-laying the canvas out wholesale.
 *
 * Three passes over UNITS (an outermost group and everything its box
 * contains move as one; every other node is its own unit):
 *
 * 1. Band alignment, per axis: units whose edge anchors sit within
 *    `TIDY_BAND_PX` of the band's FIRST member snap to that first
 *    anchor's grid-rounded value. Banding by the fixed first anchor —
 *    never a running mean — is what stops transitive chaining (A near B,
 *    C near B's new spot) from dragging a whole diagonal into one line.
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
 * Pure and total: returns ONLY the boxes that actually move; degenerate
 * input never throws. Locked nodes never move and stand as fixed
 * obstacles; out-of-scope units likewise.
 */
export interface TidyMove {
  readonly id: string
  readonly x: number
  readonly y: number
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
const TIDY_MARGIN_PX = 24
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

interface Unit {
  readonly rootId: string
  /** Member node ids that move with the unit (locked members excluded). */
  readonly movableIds: readonly string[]
  bbox: Rect
  readonly movable: boolean
  dx: number
  dy: number
}

const roundToGrid = (v: number) => Math.round(v / TIDY_GRID_PX) * TIDY_GRID_PX

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
    const movable = inScope(rootId) && !locked(rootId) && movableCount < TIDY_MAX_UNITS
    if (movable) movableCount++
    units.push({
      rootId,
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

/** One banded alignment pass along one axis (fixed-first-anchor rule). */
function alignBands(units: Unit[], axis: 'x' | 'y'): void {
  const anchor = (u: Unit) => (axis === 'x' ? u.bbox.x : u.bbox.y)
  const sorted = [...units].sort((a, b) => anchor(a) - anchor(b))
  let bandFirst: number | undefined
  for (const unit of sorted) {
    // STRICT inequality: consecutive band targets are >= one band apart
    // (multiples of the grid), so a snapped unit sitting exactly one band
    // from a neighbour must not re-join it on a later pass.
    if (bandFirst === undefined || anchor(unit) - bandFirst >= TIDY_BAND_PX) {
      bandFirst = anchor(unit)
    }
    if (!unit.movable) continue
    const target = roundToGrid(bandFirst)
    const delta = target - anchor(unit)
    if (delta === 0) continue
    if (axis === 'x') {
      unit.bbox.x += delta
      unit.dx += delta
    } else {
      unit.bbox.y += delta
      unit.dy += delta
    }
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

export function tidyNodes(
  nodes: readonly TidyNode[],
  options: TidyOptions = {},
): readonly TidyMove[] {
  const clean = usable(nodes)
  if (clean.length < 2) return []
  const byId = new Map(clean.map((n) => [n.id, n]))
  const units = buildUnits(clean, options)
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
  const moves: TidyMove[] = []
  for (const unit of units) {
    if (!unit.movable || (unit.dx === 0 && unit.dy === 0)) continue
    for (const id of unit.movableIds) {
      const node = byId.get(id)
      if (node === undefined) continue
      const x = Math.round(node.x + unit.dx)
      const y = Math.round(node.y + unit.dy)
      // Defensive twin of the canvas-workspace write guard: tidy must
      // never emit a position the doc layer would refuse.
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x === node.x && y === node.y) continue
      moves.push({ id, x, y })
    }
  }
  return moves
}
