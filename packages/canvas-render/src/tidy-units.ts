/**
 * What a tidy is about: the boxes, the OPTIONS a caller sets, and the UNITS
 * the passes actually move — an outermost frame and everything more than
 * half inside it move as one, and every other node is its own unit.
 *
 * Split from `tidy.ts` when that file passed the 800-line budget: this half
 * answers who belongs to whom, and `tidy.ts` answers what is done to them.
 * The cut is where it is because membership is GEOMETRIC — more than half
 * inside — so a frame that grows to hold a straddler can swallow the box
 * past it, and a member the overlap pass pushes out of a frame that cannot
 * grow stops being one. That is a question about units rather than about
 * any pass, and it is the one this file answers.
 */

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
  /**
   * The canvas's edges, by node id. With them a row is ORDERED as well as
   * aligned: a box whose connections along its own row all lie to one side
   * swaps with the nearest of them, so a hub that fans out sits between the
   * boxes it fans out to. Without them rows keep the order they were drawn.
   */
  readonly edges?: readonly { readonly fromNode: string; readonly toNode: string }[]
}

export const TIDY_BAND_PX = 24
export const TIDY_GRID_PX = 8
export const TIDY_MARGIN_PX = 32
/**
 * Best-effort ceiling: movable units beyond this stay put (the rest of
 * the tidy still applies). Same class of bound as the edge optimizer's
 * CROSSING_OPT_MAX_EDGES — this runs on a phone.
 */
export const TIDY_MAX_UNITS = 300

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Unit {
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

export function fullyContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

/**
 * Membership by MAJORITY, not by containment: a box more than half inside a
 * frame's own box is one of its members.
 *
 * A drawer who puts a box across a frame's edge means it to be in the frame
 * — but `fullyContains` said no, so it became its own unit and the overlap
 * pass hopped it clear of the frame entirely, leaving a member orphaned
 * OUTSIDE the group it was drawn in. Nothing caught that: JSON Canvas
 * membership is containment, so the drawing had quietly lost a member, and
 * every debt column of the drawing score reads zero on the result (the
 * straddle is gone precisely because the box no longer touches the frame).
 * Claimed instead, it is tidied among its fellow members and the frame
 * grows to hold it — passes that already existed.
 *
 * Majority rather than contact, so a frame does not swallow a neighbour it
 * overlaps by a corner. Frames that overlap each other are resolved by
 * document order, first claim winning, the same rule the scoop already had.
 */
export function mostlyInside(outer: Rect, inner: Rect): boolean {
  const area = inner.w * inner.h
  if (area <= 0) return fullyContains(outer, inner)
  const w = Math.min(outer.x + outer.w, inner.x + inner.w) - Math.max(outer.x, inner.x)
  const h = Math.min(outer.y + outer.h, inner.y + inner.h) - Math.max(outer.y, inner.y)
  return w > 0 && h > 0 && w * h * 2 > area
}

export function overlapsWithMargin(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w + TIDY_MARGIN_PX &&
    b.x < a.x + a.w + TIDY_MARGIN_PX &&
    a.y < b.y + b.h + TIDY_MARGIN_PX &&
    b.y < a.y + a.h + TIDY_MARGIN_PX
  )
}

export const rectOf = (n: TidyNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height })

export function usable(nodes: readonly TidyNode[]): TidyNode[] {
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
export function buildUnits(nodes: readonly TidyNode[], options: TidyOptions): Unit[] {
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
        (m) => !claimed.has(m.id) && (m.id === node.id || mostlyInside(rectOf(node), rectOf(m))),
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
