/**
 * Where a node goes when its caller did not say: the board-level cursor, the
 * in-group packer, the sizes a node gets when it names none, and the text a
 * refusal carries when a chosen position cannot go where it was pointed.
 * Pure geometry, so `canvas-edit.ts` keeps to the transaction.
 */
import { boundsOf, isFrame, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { NodeDraft } from './canvas-edit-ops.js'

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
export const DEFAULT_SIZE: Record<NodeDraft['type'], { width: number; height: number }> = {
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
    if (isFrame(node)) continue
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
  const bounds = boundsOf(nodes)
  if (bounds === undefined) return { x: 0, y: 0 }
  return { x: bounds.x, y: bounds.y + bounds.height + PLACEMENT_GUTTER_PX }
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
 * Each node's search RESUMES where the previous node landed instead of
 * restarting at the top row. Restarting made the k-th node of a one-wide
 * column walk k rows, each against every rect taken — cubic in the column,
 * and a region may hold every node on the board. The price is that a later,
 * smaller node does not go back for a gap an earlier one skipped, which is
 * density, and density is not promised here.
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
  const taken = new TakenRows()
  for (const rect of occupied) taken.add(rect)
  const out: { x: number; y: number }[] = []
  let from: RowCursor = { y: box.y + PLACEMENT_GUTTER_PX, x: box.x + PLACEMENT_GUTTER_PX }
  for (const size of sizes) {
    const slot = freeSlotFor(box, size, taken, from)
    out.push({ x: slot.at.x, y: slot.at.y })
    taken.add(slot.at)
    from = slot.resume
  }
  return out
}

/**
 * Why nothing can be placed inside `box`, or `undefined` when it can. Far
 * enough from the origin (past about 2^60), adding a node's size and the
 * gutter to a coordinate no longer changes it: rows would land on one
 * another and the group could not grow to hold them. The caller can fix
 * that and placement cannot, so it is refused with what to change.
 */
export function unplaceableWithin(
  box: { id: string } & Rect,
  sizes: readonly { width: number; height: number }[],
): string | undefined {
  const collapses = sizes.some(
    (size) =>
      box.x + size.width + PLACEMENT_GUTTER_PX === box.x ||
      box.y + size.height + PLACEMENT_GUTTER_PX === box.y,
  )
  if (!collapses) return undefined
  return `group "${box.id}" at (${box.x}, ${box.y}) is too far from the origin to place nodes inside it: at that magnitude adding a node's size does not move a coordinate. Give the node explicit x/y, or move the group nearer the origin`
}

/**
 * Where a slot search starts: a row's `y`, the `x` to try first, and — when
 * resuming partway along a row — the lowest bottom seen in it so far, which
 * is where the row after it starts.
 */
interface RowCursor {
  readonly y: number
  readonly x: number
  readonly midRow?: { readonly nextRow: number }
}

/**
 * The first free slot for ONE box, scanning rows top to bottom from `from`.
 *
 * Each row is walked past whatever crowds the candidate, and when the row is
 * full the next starts under the LOWEST of what blocked it. A candidate is
 * crowded only when it starts before its blocker's far edge plus the gutter,
 * which is where the next try starts, so each step past a blocker advances
 * and the walk ends once `y` is under everything taken. That holds only while
 * adding a size and the gutter moves a coordinate, which `unplaceableWithin`
 * is the caller's check for. A row's first slot is tried even for a node
 * wider than the box, which overflows rather than never landing.
 *
 * Separated from `placeWithin` because that is the only thing the outer loop
 * does: place one box, remember it, repeat. Written as three nested loops the
 * row walk, the column walk and the per-box repeat read as one algorithm, and
 * only the innermost two are.
 */
function freeSlotFor(
  box: Rect,
  size: { width: number; height: number },
  taken: TakenRows,
  from: RowCursor,
): { at: Rect; resume: RowCursor } {
  const right = box.x + box.width
  let row = from
  for (;;) {
    const walked = walkRow(size, taken, row, right)
    if ('at' in walked) return walked
    row = {
      y: walked.nextRow ?? row.y + size.height + PLACEMENT_GUTTER_PX,
      x: box.x + PLACEMENT_GUTTER_PX,
    }
  }
}

/**
 * One row's walk, from `row` to the box's right edge: the slot it found, or
 * where the row after it starts.
 */
function walkRow(
  size: { width: number; height: number },
  taken: TakenRows,
  row: RowCursor,
  right: number,
): { at: Rect; resume: RowCursor } | { nextRow: number | undefined } {
  const { y } = row
  let x = row.x
  let nextRow = row.midRow?.nextRow
  let rowStart = row.midRow === undefined
  while (rowStart || x + size.width <= right) {
    rowStart = false
    const candidate = { x, y, ...size }
    const hit = taken.firstCrowding(candidate)
    const lowest = hit ?? candidate
    const below = lowest.y + lowest.height + PLACEMENT_GUTTER_PX
    nextRow = nextRow === undefined ? below : Math.min(nextRow, below)
    if (hit === undefined) {
      return {
        at: candidate,
        resume: { y, x: x + size.width + PLACEMENT_GUTTER_PX, midRow: { nextRow } },
      }
    }
    x = hit.x + hit.width + PLACEMENT_GUTTER_PX
  }
  return { nextRow }
}

/** Height of one bucket of `TakenRows`, in canvas pixels. */
const ROW_BUCKET_PX = 512
/**
 * A rect reaching across more buckets than this is kept in one list every
 * query reads, so a very tall rect costs one entry rather than one per
 * bucket it spans — sizes are unbounded, and a bucket per 512px of a
 * million-pixel box would be the allocation this index exists to avoid.
 */
const MAX_BUCKETS_PER_RECT = 32

/**
 * The buckets `[top, bottom]` reaches, or `undefined` for the tall list. A
 * position is any finite number, and past 2^53 a bucket index no longer
 * changes when incremented, so a walk over such a span would never end: an
 * index that is not a safe integer goes to the tall list too.
 */
function bucketSpan(top: number, bottom: number): { first: number; last: number } | undefined {
  const first = Math.floor(top / ROW_BUCKET_PX)
  const last = Math.floor(bottom / ROW_BUCKET_PX)
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return undefined
  return last - first > MAX_BUCKETS_PER_RECT ? undefined : { first, last }
}

/**
 * The rects a box has taken, bucketed by the rows they crowd, so a crowding
 * test reads its neighbours instead of everything in the box. A rect sits in
 * every bucket its gutter-widened vertical extent touches, which is every
 * bucket a candidate it crowds can start a query from.
 */
class TakenRows {
  private readonly rects: Rect[] = []
  private readonly buckets = new Map<number, number[]>()
  private readonly tall: number[] = []

  add(rect: Rect): void {
    const index = this.rects.length
    this.rects.push(rect)
    const span = bucketSpan(
      rect.y - PLACEMENT_GUTTER_PX,
      rect.y + rect.height + PLACEMENT_GUTTER_PX,
    )
    if (span === undefined) {
      this.tall.push(index)
      return
    }
    for (let bucket = span.first; bucket <= span.last; bucket++) {
      const row = this.buckets.get(bucket)
      if (row === undefined) this.buckets.set(bucket, [index])
      else row.push(index)
    }
  }

  /**
   * The EARLIEST-taken rect crowding `candidate` — the one a scan of every
   * taken rect in order would have found, so which blocker the walk steps
   * past does not depend on how the rects are bucketed.
   */
  firstCrowding(candidate: Rect): Rect | undefined {
    let first = Number.POSITIVE_INFINITY
    const consider = (index: number) => {
      if (index < first && crowds(candidate, this.rects[index] as Rect)) first = index
    }
    for (const index of this.tall) consider(index)
    const span = bucketSpan(candidate.y, candidate.y + candidate.height)
    if (span === undefined) {
      for (let index = 0; index < this.rects.length; index++) consider(index)
    } else {
      for (let bucket = span.first; bucket <= span.last; bucket++) {
        for (const index of this.buckets.get(bucket) ?? []) consider(index)
      }
    }
    return this.rects[first]
  }
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
