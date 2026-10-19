import {
  type CanvasEdge,
  isFiniteRect,
  isFrame,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
// `fullyContains` is ONE predicate, and it was two byte-identical copies —
// this file's and `edge-rules`' — until the mutation lane reported eight
// survivors in this one. The copy there is exercised by name; the copy here
// was exercised by nothing, so dropping its x-containment check left all
// 1631 canvas-render tests green (measured before deleting it). Occlusion
// and frame membership ask the same geometric question, and a second copy is
// only a second thing that can be wrong.
import { fullyContains } from './layout/edges/edge-rules.js'
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
  /**
   * Whether this box is a FRAME — the one thing tidy asks about a node
   * beyond its rectangle, since an outermost frame and its members move as
   * one unit.
   *
   * A boolean rather than the model's node kind, which this interface used
   * to mirror verbatim (`'text' | 'file' | 'link' | 'group'`). That mirror
   * was a hand-written copy of a Zod union — the drift `model`'s rules exist
   * to prevent — and it bought nothing: both readings here are `=== 'group'`,
   * so three of the four arms were never distinguished. It also stood in the
   * way of ADR-0038 decision 3, which dissolves that union: a caller holding
   * a real node answers `isFrame(node)` and the geometry-only fixtures in
   * `tidy-quality.test.ts` say `frame: false` without inventing a kind for a
   * box that has no content at all.
   */
  readonly frame: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The boxes a real canvas gives tidy.
 *
 * The one place that answers "is this a frame" for a stored node, so a
 * caller never spells the discriminant and the flip that dissolves it
 * (ADR-0038 decision 3) lands here rather than at each call site.
 */
export function tidyBoxes(nodes: readonly SpatialNode[]): TidyNode[] {
  return nodes.map((node) => ({
    id: node.id,
    frame: isFrame(node),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  }))
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
  readonly edges?: readonly Pick<CanvasEdge, 'from' | 'to'>[]
}

export const TIDY_BAND_PX = 24
export const TIDY_GRID_PX = 8
export const TIDY_MARGIN_PX = 32
/**
 * Best-effort ceiling: movable units beyond this stay put (the rest of
 * the tidy still applies). Same class of bound as the edge optimizer's
 * CROSSING_OPT_MAX_EDGES — this runs on a phone.
 */
const TIDY_MAX_UNITS = 300

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
  bbox: Rect
  readonly movable: boolean
  dx: number
  dy: number
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
  // Past the line above `area` is positive, so `w * h * 2 > area` already
  // implies `w * h > 0`. The two span checks therefore rule out exactly ONE
  // case the product cannot: both spans NEGATIVE — two boxes separated on
  // both axes, whose product is positive and can exceed half the area, which
  // would have a frame claim a box diagonally across the canvas. They are
  // not boundary guards, and no input distinguishes `w > 0` from `w >= 0`
  // here, nor `&&` from `||` between them (recorded in KNOWN_EQUIVALENT with
  // this reasoning, so the lane's survivors on this line are not re-chased).
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
  return nodes.filter(isFiniteRect)
}

/**
 * Which frames stand OVER which: `h` encloses `g` when its box fully contains
 * `g`'s, identical boxes going to the earlier in document order. A frame is
 * a level's unit root iff none of its enclosers is at that level.
 *
 * Answered once for the whole board and handed to every level, because the
 * answer does not change between them: a level's nodes are a subsequence of
 * the board's, in the same order, so the tie-break agrees too. Asking each
 * level afresh cost g^2 containment tests per level, and a chain of nested
 * frames has as many levels as frames — cubic, 323s for the 2000 a canvas
 * may hold.
 *
 * Each frame's enclosers are listed smallest first, so a level's question is
 * usually settled by the first entry: the frame just around it, which is a
 * member of the same level unless it is the level's own root.
 */
export interface FrameNesting {
  readonly enclosers: (frame: TidyNode) => readonly TidyNode[]
}

export function frameNesting(nodes: readonly TidyNode[]): FrameNesting {
  const frames = nodes.filter((n) => n.frame)
  const rects = new Map(frames.map((f) => [f, rectOf(f)]))
  const rect = (f: TidyNode) => rects.get(f) ?? rectOf(f)
  const order = new Map(frames.map((f, i) => [f, i]))
  const at = (f: TidyNode) => order.get(f) ?? 0
  const area = (f: TidyNode) => f.width * f.height
  // NaN (an overflowing area) only reorders the scan; membership is decided
  // by `fullyContains` alone.
  const smallestFirst = [...frames].sort((a, b) => area(a) - area(b) || at(a) - at(b))
  const enclosers = new Map<TidyNode, TidyNode[]>()
  for (const g of frames) {
    enclosers.set(
      g,
      smallestFirst.filter(
        (h) =>
          h.id !== g.id &&
          fullyContains(rect(h), rect(g)) &&
          (!fullyContains(rect(g), rect(h)) || at(h) < at(g)),
      ),
    )
  }
  return { enclosers: (frame) => enclosers.get(frame) ?? [] }
}

/**
 * Outermost-rooted single-scoop units: a group is a unit root iff no other
 * group at this level encloses it (`FrameNesting`); each root claims every
 * yet-unclaimed node more than half inside its box in ONE flat scoop, so
 * nested groups and their members can never be double-assigned. Everything
 * else is a singleton unit.
 */
export function buildUnits(
  nodes: readonly TidyNode[],
  options: TidyOptions,
  nesting: FrameNesting = frameNesting(nodes),
): Unit[] {
  const locked = options.locked ?? (() => false)
  const inScope = (id: string) => options.scope === undefined || options.scope.has(id)
  const atLevel = new Set(nodes.filter((n) => n.frame))
  const isRoot = (g: TidyNode) => !nesting.enclosers(g).some((h) => atLevel.has(h))
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
      bbox: { ...bbox },
      movable,
      dx: 0,
      dy: 0,
    })
  }
  for (const node of nodes) {
    if (claimed.has(node.id)) continue
    if (node.frame && isRoot(node)) {
      const frame = rectOf(node)
      const members = nodes.filter(
        (m) => !claimed.has(m.id) && (m.id === node.id || mostlyInside(frame, rectOf(m))),
      )
      for (const m of members) claimed.add(m.id)
      pushUnit(node.id, members, frame)
    }
  }
  for (const node of nodes) {
    if (claimed.has(node.id)) continue
    claimed.add(node.id)
    pushUnit(node.id, [node], rectOf(node))
  }
  // Units participate in document order of their root — rebuild that order
  // (group roots were emitted before later singletons above). A level of a
  // nested chain is one unit, and needs no order.
  if (units.length < 2) return units
  const orderOf = new Map(nodes.map((n, i) => [n.id, i]))
  units.sort((a, b) => (orderOf.get(a.rootId) ?? 0) - (orderOf.get(b.rootId) ?? 0))
  return units
}
