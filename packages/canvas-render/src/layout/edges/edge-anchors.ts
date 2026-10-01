/**
 * The anchor pass: WHERE on its chosen side an edge attaches, given every
 * other edge that shares that (node, side). Ends sharing a side are spread
 * along it in a stable order and leave through distinct stub lanes
 * (`buildAnchorGroups`); a trial that re-sides one edge patches the
 * incumbent partition rather than rebuilding it (`patchAnchorGroups`), and
 * `anchor-groups.properties.test.ts` holds the two equal. `computeAnchorsFor`
 * is what the search calls per trial, over an `AnchorContext` built once per
 * search.
 *
 * Reads the side vocabulary (`edge-sides.ts`) and the geometry; knows nothing
 * of the cost model or of routing. The search (`spatial-edges.ts`) imports it.
 */

import type { EdgeSide, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode, nodeAtEnd } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type { Point, Rect } from './edge-geometry.js'
import { centerOf, rectOf, sidePointAt, tangentCoordinate } from './edge-geometry.js'
import { facingLaneWindow, oppositeSide, type SidePair } from './edge-rules.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from './edge-sides.js'
import { ORTHOGONAL_STUB_PX, STUB_LANE_STEP_PX } from './edge-sides.js'

/**
 * The layout-invariant half of `computeAnchorsFor`'s inputs, built ONCE per
 * search and reused by every trial: nodes do not move while sides are being
 * chosen, so their index, rects and centers are identical on every call. The
 * search runs that function hundreds of times per layout (measured: 252 calls
 * on the 200-edge bench, 463 on the 345-edge one), and rebuilding these per
 * call was 15% of layout time.
 *
 * Carrying `edges` alongside them is what makes the reuse safe: `ends` is
 * indexed by edge position, so a context cannot be paired with an edge list
 * it was not derived from.
 */
export interface AnchorContext {
  readonly edges: readonly RoutableElement[]
  /** Per edge index; `undefined` when either endpoint node is missing. */
  readonly ends: ReadonlyArray<AnchorEnds | undefined>
}

interface AnchorEnds {
  readonly fromRect: Rect
  readonly toRect: Rect
  readonly fromCenter: Point
  readonly toCenter: Point
}

export function anchorContext(
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
): AnchorContext {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const ends = edges.map((edge) => {
    const fromNode = nodeAtEnd(edge.from, byId)
    const toNode = nodeAtEnd(edge.to, byId)
    if (fromNode === undefined || toNode === undefined) return undefined
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    return { fromRect, toRect, fromCenter: centerOf(fromRect), toCenter: centerOf(toRect) }
  })
  return { edges, ends }
}

/**
 * One end of one edge, as the fan-out sees it. Ends are partitioned by
 * `(nodeId, side)`: a group's placement is a function of its own members and
 * nothing else, which is what lets a trial re-place only the groups it
 * disturbs (`patchAnchorGroups`).
 */
interface AnchorEnd {
  readonly edgeId: string
  readonly edgeIndex: number
  readonly role: 'from' | 'to'
  readonly rect: Rect
  readonly side: EdgeSide
  readonly farCenter: Point
}

/** Pre-alignment anchor entry: what the fan-out writes, before the aligned
 *  run slides facing pairs and before pins are applied. */
interface AnchorEntry {
  from?: Point
  to?: Point
  fromLaneDepth?: number
  toLaneDepth?: number
  fromSide?: EdgeSide
  toSide?: EdgeSide
}

/**
 * The partition plus the entries placed from it. Held across a search so a
 * one-edge trial can rebuild the two groups that edge leaves and the two it
 * joins, instead of re-deriving all of them: measured on the 200-edge bench,
 * grouping and placement are 92% of `computeAnchorsFor` (15.4ms + 27.2ms of
 * 46.4ms) and alignment only 8%, so alignment stays a full pass and only
 * this half is made incremental.
 *
 * This type and the two functions producing it are exported for one reason:
 * the incremental path is a SECOND producer of a partition the full path
 * also produces, and this package's one-producer rule admits that only with
 * a parity test pinning their agreement — see
 * `anchor-groups.properties.test.ts`.
 */
export interface AnchorGroups {
  readonly groups: Map<string, AnchorEnd[]>
  readonly entries: Map<string, AnchorEntry>
}

const groupKeyFor = (edge: RoutableElement, role: 'from' | 'to', side: EdgeSide): string =>
  `${role === 'from' ? endNode(edge.from) : endNode(edge.to)} ${side}`

function endsOfEdge(
  ctx: AnchorContext,
  edgeIndex: number,
  sides: ReadonlyMap<string, SidePair>,
): readonly [AnchorEnd, AnchorEnd] | undefined {
  const edge = ctx.edges[edgeIndex]
  const geom = ctx.ends[edgeIndex]
  if (edge === undefined || geom === undefined) return undefined
  const chosen = sides.get(edge.id)
  if (chosen === undefined) return undefined
  return [
    {
      edgeId: edge.id,
      edgeIndex,
      role: 'from',
      rect: geom.fromRect,
      side: chosen.fromSide,
      farCenter: geom.toCenter,
    },
    {
      edgeId: edge.id,
      edgeIndex,
      role: 'to',
      rect: geom.toRect,
      side: chosen.toSide,
      farCenter: geom.fromCenter,
    },
  ]
}

/**
 * Fan-out and lane depth for ONE group, written into `entries`. Each end
 * writes only its own half (`from*` or `to*`), so re-placing a group never
 * disturbs the other end of an edge that reaches into it.
 */
function placeAnchorGroup(group: readonly AnchorEnd[], entries: Map<string, AnchorEntry>): void {
  const ordered = [...group].sort(
    (a, b) =>
      tangentCoordinate(a.side, a.farCenter) - tangentCoordinate(b.side, b.farCenter) ||
      a.edgeIndex - b.edgeIndex ||
      (a.role === b.role ? 0 : a.role === 'from' ? -1 : 1),
  )
  const placed = ordered.map((end, i) => ({
    end,
    point: sidePointAt(end.rect, end.side, (i + 1) / (ordered.length + 1)),
    t: tangentCoordinate(end.side, sidePointAt(end.rect, end.side, (i + 1) / (ordered.length + 1))),
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
    const entry = entries.get(member.end.edgeId) ?? {}
    entries.set(
      member.end.edgeId,
      member.end.role === 'from'
        ? { ...entry, from: member.point, fromLaneDepth: depth, fromSide: member.end.side }
        : { ...entry, to: member.point, toLaneDepth: depth, toSide: member.end.side },
    )
  }
}

/** The whole partition, placed. */
export function buildAnchorGroups(
  ctx: AnchorContext,
  sides: ReadonlyMap<string, SidePair>,
): AnchorGroups {
  const groups = new Map<string, AnchorEnd[]>()
  ctx.edges.forEach((edge, edgeIndex) => {
    const ends = endsOfEdge(ctx, edgeIndex, sides)
    if (ends === undefined) return
    for (const end of ends) {
      const key = groupKeyFor(edge, end.role, end.side)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [end])
      else group.push(end)
    }
  })
  const entries = new Map<string, AnchorEntry>()
  for (const group of groups.values()) placeAnchorGroup(group, entries)
  return { groups, entries }
}

/**
 * The same partition with ONE edge re-sided. Every trial the side-choice
 * search evaluates is exactly this shape (`new Map(current)` plus one
 * `set`), and only the two groups that edge leaves and the two it joins can
 * differ — every other group keeps the members, and therefore the fan-out,
 * it already had. `base` is left untouched.
 */
export function patchAnchorGroups(
  ctx: AnchorContext,
  base: AnchorGroups,
  sides: ReadonlyMap<string, SidePair>,
  edgeIndex: number,
): AnchorGroups {
  const edge = ctx.edges[edgeIndex]
  const next = endsOfEdge(ctx, edgeIndex, sides)
  if (edge === undefined || next === undefined) return base
  const groups = new Map(base.groups)
  const touched = new Set<string>()
  const replace = (key: string, mutate: (members: AnchorEnd[]) => AnchorEnd[]): void => {
    const members = mutate([...(groups.get(key) ?? [])])
    // A side an edge has just left may hold nothing now. `buildAnchorGroups`
    // never creates an empty group, so keeping one here would leave the two
    // partitions unequal — harmlessly for the alignment pass, which reads a
    // missing key and an empty one alike, but the parity property compares
    // the partitions themselves and an emptied key would also accumulate
    // across a search.
    if (members.length === 0) groups.delete(key)
    else groups.set(key, members)
    touched.add(key)
  }
  // Leave the old groups. The edge's previous sides are read off the base
  // entry rather than a second side map: they are what placed it there.
  const previous = base.entries.get(edge.id)
  for (const [role, side] of [
    ['from', previous?.fromSide],
    ['to', previous?.toSide],
  ] as const) {
    if (side === undefined) continue
    replace(groupKeyFor(edge, role, side), (members) =>
      members.filter((m) => !(m.edgeId === edge.id && m.role === role)),
    )
  }
  // Join the new ones.
  for (const end of next) {
    replace(groupKeyFor(edge, end.role, end.side), (members) => [...members, end])
  }
  // Re-place only what moved. A member of a touched group keeps the half it
  // owns in another, untouched group, because `placeAnchorGroup` writes one
  // half per end onto whatever entry is already there.
  const entries = new Map(base.entries)
  // The re-sided edge needs no clearing first: both of its new groups are
  // touched by construction, and each end overwrites its own half of the
  // entry, so nothing of the old sides survives. (Clearing it anyway was
  // written here and removed — the parity property showed it changed
  // nothing.)
  for (const key of touched) {
    const group = groups.get(key)
    if (group !== undefined) placeAnchorGroup(group, entries)
  }
  return { groups, entries }
}

/**
 * Both anchors of a facing opposing pair slid to ONE tangent coordinate
 * inside the shared lane, or `undefined` when this edge is not such a pair.
 *
 * This realizes the straight segment the zero-bend rank promised, which the
 * per-side fraction placement only delivers when the two side midpoints
 * happen to align. Multi-edge sides keep their fan-out fractions:
 * collapsing two corridors onto one lane is worse than a jog — so an end
 * sharing its side with anything else disqualifies the pair.
 */
function slidFacingPair(
  entry: AnchorEntry,
  chosen: SidePair | undefined,
  geom: { fromRect: Rect; toRect: Rect } | undefined,
  edge: RoutableElement,
  groups: ReadonlyMap<string, readonly AnchorEnd[]>,
): { from: Point; to: Point } | undefined {
  if (chosen === undefined || entry.from === undefined || entry.to === undefined) return undefined
  if (chosen.toSide !== oppositeSide(chosen.fromSide)) return undefined
  if (geom === undefined) return undefined
  if ((groups.get(`${endNode(edge.from)} ${chosen.fromSide}`)?.length ?? 0) > 1) return undefined
  if ((groups.get(`${endNode(edge.to)} ${chosen.toSide}`)?.length ?? 0) > 1) return undefined

  const { fromRect, toRect } = geom
  const axis = chosen.fromSide === 'left' || chosen.fromSide === 'right' ? 'h' : 'v'
  if (!facesForward(chosen.fromSide, axis, fromRect, toRect)) return undefined
  const lane = facingLaneWindow(fromRect, toRect, axis)
  if (lane === undefined) return undefined

  const natural = (axis === 'h' ? entry.from.y + entry.to.y : entry.from.x + entry.to.x) / 2
  const t = Math.min(lane[1], Math.max(lane[0], natural))
  return {
    from: axis === 'h' ? { x: entry.from.x, y: t } : { x: t, y: entry.from.y },
    to: axis === 'h' ? { x: entry.to.x, y: t } : { x: t, y: entry.to.y },
  }
}

/**
 * Whether the two boxes are actually clear of each other in the chosen
 * direction. Interpenetrating boxes — authored sides can force them — have
 * no forward-facing lane to slide into.
 */
function facesForward(fromSide: EdgeSide, axis: 'h' | 'v', fromRect: Rect, toRect: Rect): boolean {
  if (axis === 'h') {
    return fromSide === 'right'
      ? fromRect.x + fromRect.w <= toRect.x
      : toRect.x + toRect.w <= fromRect.x
  }
  return fromSide === 'bottom'
    ? fromRect.y + fromRect.h <= toRect.y
    : toRect.y + toRect.h <= fromRect.y
}

/**
 * One entry with whatever the pin committed written over it, field by field.
 *
 * A pin is PARTIAL by design — a live drag commits the end it moved and
 * leaves the other to be placed — so an absent field keeps what the fan-out
 * pass computed rather than clearing it.
 */
function pinnedEntry(entry: AnchorEntry, pin: EdgeAnchorOverride): AnchorEntry {
  return {
    ...entry,
    ...(pin.from !== undefined ? { from: pin.from } : {}),
    ...(pin.fromLaneDepth !== undefined ? { fromLaneDepth: pin.fromLaneDepth } : {}),
    ...(pin.to !== undefined ? { to: pin.to } : {}),
    ...(pin.toLaneDepth !== undefined ? { toLaneDepth: pin.toLaneDepth } : {}),
  }
}

/** Grouping, anchor fan-out and lane depths for a FIXED side configuration. */
export function computeAnchorsFor(
  ctx: AnchorContext,
  sides: ReadonlyMap<string, SidePair>,
  // Alignment never varies WITHIN one optimizer run: sliding anchors
  // mid-optimization changes trial costs, which shifts side-choice
  // equilibria on multi-edge documents in ways the ranking never anticipated
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
  // A partition already placed for exactly these sides, when the caller has
  // one (a trial patched from the incumbent). Absent, it is built here.
  placement?: AnchorGroups,
): ReadonlyMap<string, EdgeAnchorPair> {
  const { edges, ends: edgeEnds } = ctx
  const { groups, entries } = placement ?? buildAnchorGroups(ctx, sides)
  const anchors = new Map<string, AnchorEntry>(entries)

  const applyPins = (): void => {
    if (pins === undefined) return
    for (const [id, pin] of pins) {
      const entry = anchors.get(id)
      if (entry !== undefined) anchors.set(id, pinnedEntry(entry, pin))
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
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    const edge = edges[edgeIndex] as RoutableElement
    // A pinned edge holds its committed anchors; alignment must not move it.
    if (pins?.get(edge.id)?.from !== undefined || pins?.get(edge.id)?.to !== undefined) continue
    const entry = anchors.get(edge.id)
    if (entry === undefined) continue
    const slid = slidFacingPair(entry, sides.get(edge.id), edgeEnds[edgeIndex], edge, groups)
    if (slid !== undefined) anchors.set(edge.id, { ...entry, ...slid })
  }
  applyPins()
  return anchors
}
