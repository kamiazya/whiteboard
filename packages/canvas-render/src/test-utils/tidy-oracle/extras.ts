import type { Row, TidyCase } from './oracle.js'

/**
 * Boards the generator would take a lifetime to draw: the ceilings. A board
 * past the unit ceiling, one whose frames cost more to compare than a call may
 * spend, and a chain of nested frames deep enough that the level walk runs out
 * of visits part-way, plus the totality edges (nothing, one box, ids that
 * repeat).
 */

const box = (id: string, x: number, y: number, w = 100, h = 60): Row => [id, 0, x, y, w, h]
const frame = (id: string, x: number, y: number, w: number, h: number): Row => [id, 1, x, y, w, h]

/** A grid of boxes each a few pixels off its cell. */
function gridOf(count: number, across: number): Row[] {
  return Array.from({ length: count }, (_, i) =>
    box(`g${i}`, (i % across) * 150 + ((i * 7) % 13), Math.floor(i / across) * 90 + ((i * 5) % 11)),
  )
}

/** Each frame strictly inside the last, so every frame stands over the rest. */
function chain(depth: number): Row[] {
  return Array.from({ length: depth }, (_, i) =>
    frame(`c${i}`, i * 2, i * 2, 4 * depth - i * 4, 4 * depth - i * 4),
  )
}

export const EXTRA_CASES: TidyCase[] = [
  { id: 'extra/empty', nodes: [] },
  { id: 'extra/one', nodes: [box('a', 3, 5)] },
  { id: 'extra/one-usable', nodes: [box('a', 3, 5), ['b', 0, 'nan', 0, 10, 10]] },
  { id: 'extra/identical', nodes: [box('a', 0, 0), box('b', 0, 0), box('c', 0, 0)] },
  { id: 'extra/repeated-id', nodes: [box('a', 0, 0), box('a', 10, 4), box('b', 20, 8)] },
  {
    id: 'extra/hub-with-two-equally-near-partners',
    nodes: [box('hub', 0, 0), box('a', 300, 8), box('b', 300, 0)],
    edges: [
      ['hub', 'a'],
      ['hub', 'b'],
    ],
  },
  { id: 'extra/all-locked', nodes: [box('a', 0, 3), box('b', 10, 9)], locked: ['a', 'b'] },
  { id: 'extra/scope-empty', nodes: [box('a', 0, 3), box('b', 10, 9)], scope: [] },
  { id: 'extra/past-unit-ceiling', nodes: gridOf(330, 22) },
  { id: 'extra/past-unit-ceiling-locked', nodes: gridOf(310, 20), locked: ['g0', 'g1', 'g2'] },
  {
    id: 'extra/past-frame-pair-budget',
    nodes: Array.from({ length: 4100 }, (_, i) => frame(`p${i}`, i * 3, 0, 40, 40)),
  },
  { id: 'extra/chain-short', nodes: chain(12) },
  {
    id: 'extra/chain-short-boxes',
    nodes: [...chain(8), box('a', 5, 5), box('b', 9, 11), box('c', 12, 6)],
  },
  { id: 'extra/past-level-budget', nodes: chain(1100) },
]
