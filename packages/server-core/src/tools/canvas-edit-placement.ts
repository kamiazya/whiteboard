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
 */
export const DEFAULT_SIZE: Record<SpatialNode['type'], { width: number; height: number }> = {
  text: { width: 260, height: 120 },
  file: { width: 260, height: 120 },
  link: { width: 260, height: 120 },
  group: { width: 400, height: 300 },
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
