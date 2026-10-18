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
    (size) => !stepsFrom(box.x, size.width) || !stepsFrom(box.y, size.height),
  )
  if (!collapses) return undefined
  return `group "${box.id}" at (${box.x}, ${box.y}) is too far from the origin to place nodes inside it: at that magnitude adding a node's size does not move a coordinate. Give the node explicit x/y, or move the group nearer the origin`
}

/**
 * Whether a walk along one axis of a box at `edge` advances: the first slot
 * starts a gutter in, and each step adds an extent and then a gutter, the
 * order `walkRow` computes it in. The start is not the edge — rounded, it can
 * sit on a coarser grid than the edge does — so both the step from it and the
 * step after are asked.
 */
function stepsFrom(edge: number, extent: number): boolean {
  const start = edge + PLACEMENT_GUTTER_PX
  const next = start + extent + PLACEMENT_GUTTER_PX
  return next !== start && next + extent + PLACEMENT_GUTTER_PX !== next
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
  const sweep = taken.row(y, size)
  while (rowStart || x + size.width <= right) {
    rowStart = false
    const candidate = { x, y, ...size }
    const hit = sweep.firstCrowding(x)
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
 *
 * Each bucket is kept in left-edge order, so a row's walk merges the few
 * buckets it reads instead of sorting their contents once per row.
 */
class TakenRows {
  private readonly rects: Rect[] = []
  private readonly buckets = new Map<number, Bucket>()
  private readonly tall = new Bucket()
  /** Per rect, the last row that read it: a rect in two buckets is read once. */
  private readonly readInRow: number[] = []
  private rowsRead = 0

  add(rect: Rect): void {
    const index = this.rects.length
    this.rects.push(rect)
    const span = bucketSpan(
      rect.y - PLACEMENT_GUTTER_PX,
      rect.y + rect.height + PLACEMENT_GUTTER_PX,
    )
    if (span === undefined) {
      this.tall.add(index, this.rects)
      return
    }
    for (let bucket = span.first; bucket <= span.last; bucket++) {
      let row = this.buckets.get(bucket)
      if (row === undefined) {
        row = new Bucket()
        this.buckets.set(bucket, row)
      }
      row.add(index, this.rects)
    }
  }

  /**
   * The rects crowding a candidate of `size` anywhere in the row at `y`, as a
   * sweep along it. Two boxes closer than the gutter on both axes count as
   * touching, so packing keeps it.
   */
  row(y: number, size: { width: number; height: number }): RowSweep {
    this.rowsRead += 1
    const stamp = this.rowsRead
    const inRow = (indices: readonly number[]): number[] =>
      indices.filter((index) => {
        if (this.readInRow[index] === stamp) return false
        this.readInRow[index] = stamp
        const rect = this.rects[index] as Rect
        // The vertical half of crowding, which does not depend on where
        // along the row the candidate stands.
        return (
          y < rect.y + rect.height + PLACEMENT_GUTTER_PX &&
          rect.y < y + size.height + PLACEMENT_GUTTER_PX
        )
      })
    const span = bucketSpan(y, y + size.height)
    const sources =
      span === undefined
        ? [
            byLeft(
              this.rects.map((_, index) => index),
              this.rects,
            ),
          ]
        : [this.tall.inOrder(this.rects), ...this.spanned(span)]
    const members = sources.map(inRow).reduce((a, b) => mergeByLeft(a, b, this.rects), [])
    return new RowSweep(members, this.rects, size.width)
  }

  private spanned(span: { first: number; last: number }): (readonly number[])[] {
    const out: (readonly number[])[] = []
    for (let bucket = span.first; bucket <= span.last; bucket++) {
      const row = this.buckets.get(bucket)
      if (row !== undefined) out.push(row.inOrder(this.rects))
    }
    return out
  }
}

/** Indices sorted by their rect's left edge. */
function byLeft(indices: number[], rects: readonly Rect[]): number[] {
  return indices.sort((a, b) => (rects[a] as Rect).x - (rects[b] as Rect).x)
}

function mergeByLeft(a: readonly number[], b: readonly number[], rects: readonly Rect[]): number[] {
  if (a.length === 0) return [...b]
  if (b.length === 0) return [...a]
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const left = a[i] as number
    const right = b[j] as number
    if ((rects[left] as Rect).x <= (rects[right] as Rect).x) {
      out.push(left)
      i += 1
    } else {
      out.push(right)
      j += 1
    }
  }
  for (; i < a.length; i++) out.push(a[i] as number)
  for (; j < b.length; j++) out.push(b[j] as number)
  return out
}

/**
 * One bucket's rect indices. Filled unsorted while a box's held rects are
 * loaded and sorted once when first read; a rect placed after that is
 * inserted where its left edge goes.
 */
class Bucket {
  private indices: number[] = []
  private sorted = true

  add(index: number, rects: readonly Rect[]): void {
    if (!this.sorted || this.indices.length === 0) {
      this.indices.push(index)
      this.sorted = this.indices.length === 1
      return
    }
    const x = (rects[index] as Rect).x
    let low = 0
    let high = this.indices.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((rects[this.indices[mid] as number] as Rect).x <= x) low = mid + 1
      else high = mid
    }
    this.indices.splice(low, 0, index)
  }

  inOrder(rects: readonly Rect[]): readonly number[] {
    if (!this.sorted) {
      this.indices = byLeft(this.indices, rects)
      this.sorted = true
    }
    return this.indices
  }
}

/**
 * One row's crowding rects, answering for a candidate that only moves right.
 *
 * It answers the EARLIEST-taken rect crowding the candidate — the one a scan
 * of every taken rect in order would find — because which blocker a step
 * clears decides which bottoms the row's `nextRow` is the minimum of, and so
 * where the next row starts. Any other blocker lands nodes elsewhere.
 *
 * A rect starts crowding once the candidate's far edge plus the gutter passes
 * its left edge, and stops once the candidate starts past its right edge plus
 * the gutter. Both thresholds only move one way as `x` grows, so rects enter
 * in left-edge order and, once out, never return: each enters and leaves a
 * heap keyed by when it was taken at most once, and a row costs O(n log n) in
 * the rects it holds however many steps its walk takes.
 */
class RowSweep {
  private entered = 0
  private readonly active: number[] = []

  constructor(
    private readonly byLeft: readonly number[],
    private readonly rects: readonly Rect[],
    private readonly width: number,
  ) {}

  /** `x` must not decrease between calls. */
  firstCrowding(x: number): Rect | undefined {
    for (;;) {
      const next = this.byLeft[this.entered]
      if (next === undefined) break
      if (!((this.rects[next] as Rect).x < x + this.width + PLACEMENT_GUTTER_PX)) break
      this.push(next)
      this.entered += 1
    }
    for (;;) {
      const top = this.active[0]
      if (top === undefined) return undefined
      const rect = this.rects[top] as Rect
      if (x < rect.x + rect.width + PLACEMENT_GUTTER_PX) return rect
      this.pop()
    }
  }

  private push(index: number): void {
    const heap = this.active
    let at = heap.length
    heap.push(index)
    while (at > 0) {
      const parent = (at - 1) >> 1
      if ((heap[parent] as number) <= index) break
      heap[at] = heap[parent] as number
      at = parent
    }
    heap[at] = index
  }

  private pop(): void {
    const heap = this.active
    const last = heap.pop() as number
    if (heap.length === 0) return
    let at = 0
    for (;;) {
      const left = 2 * at + 1
      if (left >= heap.length) break
      const right = left + 1
      const child =
        right < heap.length && (heap[right] as number) < (heap[left] as number) ? right : left
      if ((heap[child] as number) >= last) break
      heap[at] = heap[child] as number
      at = child
    }
    heap[at] = last
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
