import type { EdgeSpec, Num, Row, TidyCase } from './oracle.js'

/**
 * Boards drawn once from a pinned seed and committed as data, dense in what
 * tidy branches on. A uniform field would almost never put two boxes within a
 * band of each other on the near edge, the centre AND the far edge, so rows and
 * columns are laid on a few anchors and then knocked a few pixels off; frames
 * are drawn so members straddle their edges; and every board may carry a scope,
 * locks and edges, because each is a separate branch of the unit, margin and
 * row-order rules.
 */

type Next = () => number

const unit = (next: Next): number => next() / 4_294_967_296
const int = (next: Next, lo: number, hi: number): number =>
  lo + Math.floor(unit(next) * (hi - lo + 1))
const chance = (next: Next, p: number): boolean => unit(next) < p
const pick = <T>(next: Next, items: readonly T[]): T => items[int(next, 0, items.length - 1)] as T

const WIDTHS = [60, 100, 140, 200, 240]
const HEIGHTS = [40, 60, 80, 120]

/** An offset: usually zero or a few pixels, now and then a band's width. */
function jitter(next: Next): number {
  const roll = unit(next)
  if (roll < 0.3) return 0
  if (roll < 0.8) return int(next, -14, 14)
  return int(next, -40, 40)
}

interface Board {
  rows: Row[]
  frames: number
}

const row = (id: string, frame: boolean, x: number, y: number, w: number, h: number): Row => [
  id,
  frame ? 1 : 0,
  x,
  y,
  w,
  h,
]

/** Boxes on a few shared rows and columns, each anchored by an edge, a centre or a far edge. */
function anchored(next: Next, count: number): Board {
  const rowsAt = [0, 96, 200, 304].slice(0, int(next, 1, 4))
  const colsAt = [0, 240, 480, 720].slice(0, int(next, 1, 4))
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    const w = pick(next, WIDTHS)
    const h = pick(next, HEIGHTS)
    const ay = pick(next, rowsAt)
    const ax = pick(next, colsAt)
    const y = chance(next, 0.5) ? ay + jitter(next) : ay - h / 2 + jitter(next)
    const roll = unit(next)
    const x =
      roll < 0.5
        ? ax + jitter(next)
        : roll < 0.75
          ? ax - w / 2 + jitter(next)
          : ax - w + jitter(next)
    rows.push(row(`n${i}`, false, x, y, w, h))
  }
  return { rows, frames: 0 }
}

/** A crowd: the boxes are large against the field, so most of them collide. */
function crowded(next: Next, count: number): Board {
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    rows.push(
      row(
        `n${i}`,
        false,
        int(next, 0, 640),
        int(next, 0, 480),
        pick(next, [60, 100, 140]),
        pick(next, [40, 60]),
      ),
    )
  }
  return { rows, frames: 0 }
}

/** Frames with members inside, straddling an edge, or just outside, among loose boxes. */
function framed(next: Next, count: number): Board {
  const frames = int(next, 1, 3)
  const rows: Row[] = []
  const boxes: [number, number, number, number][] = []
  for (let f = 0; f < frames; f++) {
    const fx = int(next, -2, 14) * 40 + (chance(next, 0.3) ? int(next, -9, 9) : 0)
    const fy = int(next, -1, 8) * 40 + (chance(next, 0.3) ? int(next, -9, 9) : 0)
    const fw = int(next, 6, 18) * 40
    const fh = int(next, 4, 12) * 40
    rows.push(row(`f${f}`, true, fx, fy, fw, fh))
    boxes.push([fx, fy, fw, fh])
  }
  for (let i = 0; i < count; i++) {
    const [fx, fy, fw, fh] = pick(next, boxes)
    const w = pick(next, WIDTHS)
    const h = pick(next, HEIGHTS)
    const roll = unit(next)
    // Inside, hugging the corner, across an edge, or outside it.
    const x =
      roll < 0.45
        ? fx + int(next, 0, Math.max(0, fw - w))
        : roll < 0.7
          ? fx + int(next, 0, 40)
          : fx + fw - w + int(next, -20, 60)
    const y = chance(next, 0.55) ? fy + int(next, 0, Math.max(0, fh - h)) : fy + int(next, -30, fh)
    rows.push(row(`n${i}`, false, x, y, w, h))
  }
  return { rows, frames }
}

/** Frames inside frames, each strictly inside the last or across its edge. */
function nested(next: Next, count: number): Board {
  const depth = int(next, 2, 5)
  const rows: Row[] = []
  let x = int(next, 0, 3) * 8
  let y = int(next, 0, 3) * 8
  let w = 900 + int(next, 0, 8) * 40
  let h = 700 + int(next, 0, 6) * 40
  for (let d = 0; d < depth; d++) {
    rows.push(row(`f${d}`, true, x, y, w, h))
    x += int(next, 0, 80)
    y += int(next, 0, 80)
    w = Math.max(160, w - int(next, 40, 220))
    h = Math.max(120, h - int(next, 40, 160))
  }
  for (let i = 0; i < count; i++) {
    const w2 = pick(next, WIDTHS)
    const h2 = pick(next, HEIGHTS)
    rows.push(row(`n${i}`, false, int(next, 0, 700), int(next, 0, 520), w2, h2))
  }
  return { rows: shuffled(next, rows), frames: depth }
}

function shuffled<T>(next: Next, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(next, 0, i)
    const keep = out[i] as T
    out[i] = out[j] as T
    out[j] = keep
  }
  return out
}

/** One row of boxes with a hub drawn at an end, and a few edges along it. */
function fanOut(next: Next, count: number): Board {
  const rows: Row[] = []
  const y = pick(next, [0, 96, 100])
  let x = 0
  for (let i = 0; i < count; i++) {
    const w = pick(next, [100, 140, 200])
    // Now and then two boxes share a column, so a hub has two equally near partners.
    const stacked = i > 0 && chance(next, 0.2)
    rows.push(
      row(
        `n${i}`,
        false,
        stacked ? x - 40 : x,
        y + (stacked ? int(next, 0, 16) : jitter(next)),
        w,
        60,
      ),
    )
    if (!stacked) x += w + pick(next, [40, 60, 100, 140])
  }
  return { rows, frames: 0 }
}

const STRANGE: readonly Num[] = [
  0,
  0,
  1,
  -1,
  0.4,
  0.5,
  1.5,
  -0.5,
  -2.5,
  7.25,
  33.3,
  1e6,
  -1e6,
  1e15,
  1e308,
  -1e308,
  'nan',
  'inf',
  '-inf',
]
const STRANGE_SIZES: readonly Num[] = [
  0,
  0,
  0.4,
  0.5,
  1,
  7,
  33.3,
  100,
  1e6,
  1e308,
  -40,
  'nan',
  'inf',
]

/** Zero, negative, fractional, enormous and non-finite boxes, and repeated ids. */
function degenerate(next: Next, count: number): Board {
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    const id = chance(next, 0.12) ? 'dup' : `n${i}`
    const sane = chance(next, 0.5)
    rows.push([
      id,
      chance(next, 0.25) ? 1 : 0,
      sane ? int(next, -80, 400) + (chance(next, 0.4) ? 0.5 : 0) : pick(next, STRANGE),
      sane ? int(next, -80, 300) + (chance(next, 0.4) ? 0.25 : 0) : pick(next, STRANGE),
      sane ? pick(next, [0, 8, 30, 100, 33.5]) : pick(next, STRANGE_SIZES),
      sane ? pick(next, [0, 8, 30, 60, 33.5]) : pick(next, STRANGE_SIZES),
    ])
  }
  return { rows, frames: 0 }
}

/** A profile with its coordinates knocked off the whole pixel: half and quarter pixels. */
const fractional =
  (profile: (next: Next, count: number) => Board) =>
  (next: Next, count: number): Board => {
    const { rows, frames } = profile(next, count)
    const off = (v: Num): Num =>
      typeof v === 'number' && chance(next, 0.4) ? v + pick(next, [0.25, 0.5, 0.75, -0.5]) : v
    return {
      rows: rows.map(([id, f, x, y, w, h]) => [id, f, off(x), off(y), off(w), off(h)] as Row),
      frames,
    }
  }

const PROFILES: readonly ((next: Next, count: number) => Board)[] = [
  anchored,
  anchored,
  crowded,
  framed,
  framed,
  nested,
  fanOut,
  degenerate,
  fractional(anchored),
  fractional(framed),
]

function edgesFor(next: Next, ids: readonly string[]): EdgeSpec[] {
  const edges: EdgeSpec[] = []
  const hub = pick(next, ids)
  const fan = int(next, 0, 4)
  for (let i = 0; i < fan; i++)
    edges.push(chance(next, 0.5) ? [hub, pick(next, ids)] : [pick(next, ids), hub])
  for (let i = int(next, 0, 3); i > 0; i--) {
    const roll = unit(next)
    edges.push(
      roll < 0.7
        ? [pick(next, ids), pick(next, ids)]
        : roll < 0.8
          ? [null, pick(next, ids)]
          : roll < 0.9
            ? [pick(next, ids), 'ghost']
            : [null, null],
    )
  }
  return edges
}

/** `boards` cases, drawn in order from `next`. */
export function seededCases(next: Next, boards: number): TidyCase[] {
  const cases: TidyCase[] = []
  for (let b = 0; b < boards; b++) {
    const profile = PROFILES[b % PROFILES.length] as (next: Next, count: number) => Board
    const { rows } = profile(next, int(next, 2, profile === crowded ? 12 : 10))
    const ids = rows.map((r) => r[0])
    const scope = chance(next, 0.3) ? ids.filter(() => chance(next, 0.5)) : undefined
    const locked = chance(next, 0.3) ? ids.filter(() => chance(next, 0.2)) : undefined
    const edges = chance(next, profile === fanOut ? 0.95 : 0.35) ? edgesFor(next, ids) : undefined
    cases.push({
      id: `seeded/${b}`,
      nodes: rows,
      ...(scope === undefined ? {} : { scope }),
      ...(locked === undefined ? {} : { locked }),
      ...(edges === undefined ? {} : { edges }),
    })
  }
  return cases
}
