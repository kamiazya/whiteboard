/**
 * Where a node goes when its caller did not say: the board-level cursor, the
 * in-group packer, the sizes a node gets when it names none, and the text a
 * refusal carries when a chosen position cannot go where it was pointed.
 * Pure geometry, so `canvas-edit.ts` keeps to the transaction.
 */
import type { SpatialNode } from '@kamiazya/whiteboard-model'

/** How many auto-placed nodes go in a row before the next one wraps. */
export const PLACEMENT_COLUMNS = 4
/** Gap left between auto-placed nodes, and between them and existing content. */
export const PLACEMENT_GUTTER_PX = 40

/**
 * Size given to a node that names none. A model asked to invent four
 * integers per node spends its attention on arithmetic instead of on the
 * diagram, so every geometry field is optional and these fill the gap.
 *
 * The WIDTH here is only the fallback; `prevailingWidth` below takes
 * precedence when the board has an opinion, and says why.
 */
export const DEFAULT_SIZE: Record<SpatialNode['type'], { width: number; height: number }> = {
  text: { width: 260, height: 120 },
  file: { width: 260, height: 120 },
  link: { width: 260, height: 120 },
  group: { width: 400, height: 300 },
}

/**
 * The width this board already uses, or `undefined` when it has no opinion.
 *
 * A box whose width differs from its neighbours' lands its left edge on
 * their column and misses with its centre and its right edge, because
 * alignment is judged against the nearest of those three anchors. So a
 * sized-by-default box costs a near miss on every board that has a width —
 * which is nearly all of them: nine of the drawing corpus's eleven boards
 * use exactly ONE box width, and the two that do not have an unambiguous
 * commonest one.
 *
 * That makes this a better default than any constant could be, and the
 * constant was nobody's preference anyway: the corpus is 200 where this
 * file said 260, and the one board a model drew itself is a uniform 220.
 *
 * The HEIGHT is deliberately not treated the same way. It is already
 * derived from the text at the chosen width, so it follows this width
 * rather than fighting it, and a row anchor is not what the near miss was
 * about.
 *
 * COMMONEST, not widest or first: the one non-uniform board in the corpus
 * is a row of six at one width with a single squeezed neighbour, and the
 * six are what a new box should join. Ties go to the wider, which no real
 * board has needed — a deterministic answer is required and the wider box
 * is the one whose text is less likely to need wrapping.
 *
 * Groups are excluded from the vote and keep their own default: a group is
 * a container rather than a box on the column, and one enclosing the board
 * would outvote every box inside it.
 *
 * There is deliberately NO minimum. A board of narrow boxes gets a narrow
 * one, which is the rule doing its job, and the height already grows to
 * hold the text at whatever width is chosen. A floor would be exactly the
 * invented constant this function exists to remove, and nothing has
 * measured one: the corpus runs 150-220. If narrow boards turn out to read
 * badly, that is a finding with a number attached, not a guess to make now.
 */
export function prevailingWidth(nodes: readonly SpatialNode[]): number | undefined {
  const counts = new Map<number, number>()
  for (const node of nodes) {
    if (node.type === 'group') continue
    counts.set(node.width, (counts.get(node.width) ?? 0) + 1)
  }
  let best: number | undefined
  let bestCount = 0
  for (const [width, count] of counts) {
    if (count > bestCount || (count === bestCount && width > (best ?? 0))) {
      best = width
      bestCount = count
    }
  }
  return best
}

function contentBottomLeft(nodes: readonly SpatialNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 }
  const left = Math.min(...nodes.map((node) => node.x))
  const bottom = Math.max(...nodes.map((node) => node.y + node.height))
  return { x: left, y: bottom + PLACEMENT_GUTTER_PX }
}

/**
 * Lays coordinate-less nodes out in a fixed grid below whatever is already
 * on the board. Deliberately dumb and therefore explainable: an agent can
 * predict where its nodes will land, and `tidy` is one more op away when
 * the result wants refining.
 *
 * ponytail: fixed `PLACEMENT_COLUMNS`-wide grid below existing content;
 * upgrade to free-region packing (`sceneDigest`'s `freeRegions`) if
 * placement quality turns out to matter more than predictability.
 */
export class PlacementCursor {
  private started = false
  private baseX = 0
  private x = 0
  private y = 0
  private rowHeight = 0
  private column = 0

  next(nodes: readonly SpatialNode[], width: number, height: number): { x: number; y: number } {
    if (!this.started) {
      // Anchored ONCE, off the board as it stood at the first placement —
      // re-reading it per node would chase the nodes this batch is adding.
      const origin = contentBottomLeft(nodes)
      this.baseX = origin.x
      this.x = origin.x
      this.y = origin.y
      this.started = true
    }
    const at = { x: this.x, y: this.y }
    this.x += width + PLACEMENT_GUTTER_PX
    this.rowHeight = Math.max(this.rowHeight, height)
    this.column += 1
    if (this.column >= PLACEMENT_COLUMNS) {
      this.x = this.baseX
      this.y += this.rowHeight + PLACEMENT_GUTTER_PX
      this.rowHeight = 0
      this.column = 0
    }
    return at
  }
}

export type Rect = { x: number; y: number; width: number; height: number }

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Two boxes closer than the gutter count as touching, so packing keeps it. */
function crowds(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width + PLACEMENT_GUTTER_PX &&
    b.x < a.x + a.width + PLACEMENT_GUTTER_PX &&
    a.y < b.y + b.height + PLACEMENT_GUTTER_PX &&
    b.y < a.y + a.height + PLACEMENT_GUTTER_PX
  )
}

/**
 * Lays coordinate-less nodes out INSIDE a box, in rows from its top-left,
 * around what the box already holds.
 *
 * `region.set` cannot use the board-level cursor: that one places below all
 * existing content, which for a region op lands the node outside the very
 * region it was declared in — and therefore out of scope on the next call,
 * so the op would not be idempotent.
 *
 * `occupied` is what the region keeps. Without it the first placement
 * started from the top-left as if the group were empty and landed on the
 * box already there; measured on the lane, a model then spent a call moving
 * it. Each row is walked past whatever crowds the candidate, and when the
 * row is full the next starts under the lowest of what blocked it.
 *
 * ponytail: a node wider than the box overflows it rather than being shrunk
 * (the caller grows the box). Pack properly if regions turn out to be used
 * for dense layouts.
 */
export function placeWithin(
  box: Rect,
  sizes: readonly { width: number; height: number }[],
  occupied: readonly Rect[],
): { x: number; y: number }[] {
  const taken: Rect[] = [...occupied]
  const left = box.x + PLACEMENT_GUTTER_PX
  const right = box.x + box.width
  const out: { x: number; y: number }[] = []
  for (const size of sizes) {
    let y = box.y + PLACEMENT_GUTTER_PX
    for (;;) {
      let x = left
      let nextRow: number | undefined
      let at: Rect | undefined
      for (;;) {
        const candidate = { x, y, ...size }
        const hit = taken.find((rect) => crowds(candidate, rect))
        if (hit === undefined) {
          at = candidate
          break
        }
        const below = hit.y + hit.height + PLACEMENT_GUTTER_PX
        nextRow = nextRow === undefined ? below : Math.min(nextRow, below)
        x = hit.x + hit.width + PLACEMENT_GUTTER_PX
        if (x + size.width > right) break
      }
      if (at !== undefined) {
        out.push({ x: at.x, y: at.y })
        taken.push(at)
        break
      }
      // Every hit sits at or below y with the gutter, so this strictly
      // advances and the walk ends once y is under everything taken.
      y = nextRow ?? y + size.height + PLACEMENT_GUTTER_PX
    }
  }
  return out
}

/**
 * Why a positioned node cannot go in the group it named, with the way out.
 * Only a position before the group's top-left gets here — past the right or
 * bottom edge the group grows instead. A model told only "would not be
 * inside" shrank every box in the group to fit (lane, 2026-09); the number it
 * is over by and the cheaper repairs are what it needed.
 */
export function outsideDetail(
  id: string,
  node: { x: number; y: number },
  bounds: { id: string; x: number; y: number },
): string {
  const over: string[] = []
  if (node.x < bounds.x) over.push(`left edge ${node.x} is before the group's ${bounds.x}`)
  if (node.y < bounds.y) over.push(`top edge ${node.y} is above the group's ${bounds.y}`)
  return `node "${id}" would not be inside "${bounds.id}": ${over.join(', ')}. The group grows to the right and down but keeps its top-left: move the node, or omit its x/y to have it placed inside`
}
