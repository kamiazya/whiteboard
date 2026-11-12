import { mulberry32, type Num, type Spec, type SpecNode, seededSpec } from './spec.js'

/**
 * The arrangements `sceneDigest`'s guards exist for, each a spec the recording
 * holds inline: ids and the unidentified fallback, comment and proposal chrome,
 * the flags, overlap against touching, containment's ties, the cluster
 * threshold, the free-region grid at its edges and caps, and boxes no layout
 * draws (negative, zero, huge, not numbers).
 */
export interface Case {
  readonly id: string
  readonly spec: Spec
}

const shape = (i: string | undefined, x: Num, y: Num, w: Num, h: Num, f?: string): SpecNode => ({
  t: 's',
  ...(i === undefined ? {} : { i }),
  b: [x, y, w, h],
  ...(f === undefined ? {} : { f }),
})
const glyph = (x: Num, y: Num, w: Num, h: Num): SpecNode => ({ t: 'g', b: [x, y, w, h] })
const edge = (i: string): SpecNode => ({ t: 'e', i })
const boxes = (...b: readonly (readonly [Num, Num, Num, Num])[]): Spec =>
  b.map(([x, y, w, h]) => glyph(x, y, w, h))

const named: readonly Case[] = [
  { id: 'empty', spec: [] },
  { id: 'one box', spec: boxes([0, 0, 100, 40]) },
  { id: 'one zero box', spec: boxes([0, 0, 0, 0]) },
  { id: 'one negative zero box', spec: boxes(['-0', 0, 10, 10]) },
  { id: 'an edge alone', spec: [edge('e')] },
  {
    id: 'an edge beside boxes',
    spec: [edge('e'), glyph(0, 0, 10, 10), edge('f'), glyph(50, 0, 10, 10)],
  },
  {
    id: 'unidentified positions skip an edge',
    spec: [glyph(0, 0, 5, 5), edge('e'), shape(undefined, 40, 0, 5, 5)],
  },
  {
    id: 'ids with a glyph beside',
    spec: [shape('a', 0, 0, 30, 30), glyph(5, 5, 4, 4), shape('b', 100, 0, 20, 20)],
  },
  {
    id: 'identified shapes hide the unidentified',
    spec: [shape('named', 0, 0, 10, 10), shape(undefined, 50, 50, 10, 10)],
  },
  {
    id: 'comment chrome is not a node',
    spec: [shape('n', 0, 0, 100, 60), shape('c1', 90, -10, 24, 24, 'c'), edge('lead')],
  },
  { id: 'a comment alone falls back to its position', spec: [shape('c1', 0, 0, 24, 24, 'c')] },
  {
    id: 'comments alone keep their positions',
    spec: [shape('c1', 0, 0, 24, 24, 'c'), shape('c2', 200, 0, 24, 24, 'c')],
  },
  {
    id: 'proposal chrome is not a node',
    spec: [
      shape('n', 0, 0, 100, 60),
      shape('p1', -4, -4, 108, 68, 'p'),
      shape('bubble', 110, 0, 60, 30, 'p'),
    ],
  },
  { id: 'a proposal alone falls back to its position', spec: [shape('p1', 0, 0, 10, 10, 'p')] },
  {
    id: 'comment and proposal chrome together',
    spec: [shape('c', 0, 0, 5, 5, 'cp'), shape('x', 20, 0, 5, 5)],
  },
  {
    id: 'truncated and overflowing flags',
    spec: [
      shape('cut', 0, 0, 10, 10, 't'),
      shape('tight', 50, 0, 10, 10, 'o'),
      shape('both', 100, 0, 10, 10, 'to'),
      shape('plain', 150, 0, 10, 10),
    ],
  },
  {
    id: 'flags are lost on the positional fallback',
    spec: [shape(undefined, 0, 0, 10, 10, 'to'), glyph(30, 0, 10, 10)],
  },
  {
    id: 'flags beside a comment chrome',
    spec: [shape('a', 0, 0, 10, 10, 't'), shape('c', 5, 5, 5, 5, 'ct')],
  },
  {
    id: 'touching boxes do not overlap',
    spec: boxes([0, 0, 10, 10], [10, 0, 10, 10], [0, 10, 10, 10]),
  },
  { id: 'a one-pixel overlap', spec: boxes([0, 0, 10, 10], [9, 9, 10, 10]) },
  { id: 'a zero-size box inside overlaps nothing', spec: boxes([0, 0, 10, 10], [5, 5, 0, 0]) },
  {
    id: 'overlap pairs order by code unit',
    spec: [
      shape('', 0, 0, 50, 50),
      shape('\u{1f600}', 10, 10, 50, 50),
      shape('￿', 20, 20, 50, 50),
      shape('a', 30, 30, 50, 50),
    ],
  },
  {
    id: 'a pair lists its smaller id first',
    spec: [shape('b', 0, 0, 10, 10), shape('a', 5, 5, 10, 10)],
  },
  {
    id: 'pairs share a first id and order by the second',
    spec: [shape('a', 0, 0, 100, 100), shape('c', 90, 0, 20, 20), shape('b', 0, 90, 20, 20)],
  },
  {
    id: 'a chain of containment takes the smallest parent',
    spec: [
      shape('big', 0, 0, 100, 100),
      shape('mid', 10, 10, 50, 50),
      shape('small', 20, 20, 10, 10),
    ],
  },
  {
    id: 'identical boxes are overlap, not containment',
    spec: [shape('a', 0, 0, 10, 10), shape('b', 0, 0, 10, 10)],
  },
  {
    id: 'a shared border still contains',
    spec: [shape('p', 0, 0, 20, 20), shape('c', 0, 0, 10, 10)],
  },
  {
    id: 'two parents of equal area tie by id',
    spec: [shape('p2', 0, 0, 20, 20), shape('p1', 0, 0, 20, 20), shape('c', 5, 5, 2, 2)],
  },
  {
    id: 'parents tie by code unit, not by byte',
    spec: [shape('', 0, 0, 20, 20), shape('\u{1f600}', 0, 0, 20, 20), shape('c', 5, 5, 2, 2)],
  },
  {
    id: 'a parent of smaller area wins whichever is listed first',
    spec: [shape('wide', 0, 0, 200, 20), shape('square', 0, 0, 30, 30), shape('c', 5, 5, 2, 2)],
  },
  {
    id: 'containment orders by child',
    spec: [
      shape('z', 0, 0, 20, 20),
      shape('b', 5, 5, 2, 2),
      shape('x', 100, 0, 20, 20),
      shape('c', 105, 5, 2, 2),
      shape('y', 200, 0, 20, 20),
      shape('a', 205, 5, 2, 2),
    ],
  },
  {
    id: 'a repeated id is never its own parent',
    spec: [shape('a', 0, 0, 20, 20), shape('a', 5, 5, 2, 2)],
  },
  {
    id: 'a repeated child id orders by parent',
    spec: [
      shape('q', 100, 0, 20, 20),
      shape('a', 105, 5, 2, 2),
      shape('p', 0, 0, 20, 20),
      shape('a', 5, 5, 2, 2),
    ],
  },
  {
    id: 'a repeated id joins distant boxes into one cluster',
    spec: [
      shape('a', 0, 0, 10, 10),
      shape('b', 500, 0, 10, 10),
      shape('a', 1000, 0, 10, 10),
      shape('c', 2000, 0, 10, 10),
    ],
  },
  { id: 'a gap of exactly 24 clusters', spec: boxes([0, 0, 10, 10], [34, 0, 10, 10]) },
  { id: 'a gap just over 24 does not', spec: boxes([0, 0, 10, 10], [34.000001, 0, 10, 10]) },
  {
    id: 'a diagonal gap is measured whole',
    spec: boxes([0, 0, 10, 10], [26, 26, 10, 10], [60, 60, 10, 10], [76, 76, 10, 10]),
  },
  { id: 'the right-hand box listed first', spec: boxes([100, 0, 10, 10], [0, 0, 80, 10]) },
  {
    id: 'a chain links through a middle box',
    spec: boxes([0, 0, 10, 10], [30, 0, 10, 10], [60, 0, 10, 10], [200, 0, 10, 10]),
  },
  {
    id: 'clusters order by their first id',
    spec: [
      shape('z', 0, 0, 10, 10),
      shape('y', 500, 0, 10, 10),
      shape('a', 1000, 0, 10, 10),
      shape('b', 1005, 0, 10, 10),
    ],
  },
  {
    id: 'clusters order by code unit',
    spec: [
      shape('', 0, 0, 10, 10),
      shape('\u{1f600}', 500, 0, 10, 10),
      shape('￿', 1000, 0, 10, 10),
    ],
  },
  {
    id: 'ids that need escaping',
    spec: [
      shape('q"\\', 0, 0, 10, 10),
      shape('\u0001\u001f\n\t', 5, 5, 10, 10),
      shape(' \u007f', 400, 0, 10, 10),
      shape('\u{10000}', 800, 0, 10, 10),
    ],
  },
  { id: 'free cells right of a box', spec: boxes([0, 0, 20, 20], [60, 0, 20, 20]) },
  { id: 'two corner boxes', spec: boxes([0, 0, 20, 20], [40, 40, 20, 20]) },
  {
    id: 'a box ending on a grid line leaves the next cell',
    spec: boxes([0, 0, 40, 20], [60, 20, 20, 20]),
  },
  { id: 'a box off the grid lines', spec: boxes([0, 0, 25, 33], [47, 51, 13, 7]) },
  { id: 'a single box fills the grid', spec: boxes([0, 0, 40, 40]) },
  { id: 'a zero box on a grid line', spec: boxes([0, 0, 40, 40], [20, 20, 0, 0]) },
  { id: 'a zero-width box inside a cell', spec: boxes([0, 0, 40, 40], [30, 10, 0, 30]) },
  { id: 'a negative width', spec: boxes([0, 0, -10, 10], [3, 3, 5, 5]) },
  { id: 'a negative height', spec: boxes([0, 0, 50, -20], [30, 30, 40, 40]) },
  { id: 'negative coordinates', spec: boxes([-100, -50, 20, 20], [40, 30, 20, 20]) },
  { id: 'fractional coordinates', spec: boxes([0.5, 0.25, 19.5, 19.75], [60.125, 40.5, 20, 20]) },
  { id: 'three boxes in a row', spec: boxes([0, 0, 20, 20], [40, 0, 20, 20], [80, 0, 20, 20]) },
  { id: 'exactly the cell budget', spec: boxes([0, 0, 20, 20], [9980, 9980, 20, 20]) },
  { id: 'one cell past the cell budget', spec: boxes([0, 0, 20, 20], [9980, 10000, 20, 20]) },
  { id: 'a tall empty board is capped', spec: boxes([0, 0, 20, 20], [0, 4999980, 20, 20]) },
  { id: 'a wide empty board is capped', spec: boxes([0, 0, 20, 20], [4999980, 0, 20, 20]) },
  { id: 'a huge box', spec: boxes([0, 0, 1e300, 1e300], [0, 0, 1, 1]) },
  { id: 'a huge coordinate', spec: boxes([0, 0, 10, 10], [1e300, 0, 10, 10]) },
  { id: 'an infinite width', spec: boxes([0, 0, 'inf', 10], [0, 0, 5, 5]) },
  { id: 'an infinite left edge', spec: boxes(['-inf', 0, 10, 10], [0, 0, 5, 5]) },
  { id: 'an infinite coordinate cannot be allocated', spec: boxes(['inf', 0, 10, 10]) },
  { id: 'a NaN height', spec: boxes([0, 0, 10, 'nan'], [5, 5, 5, 5]) },
  { id: 'a NaN width cannot be allocated', spec: boxes([0, 0, 'nan', 10]) },
  { id: 'a NaN coordinate cannot be allocated', spec: boxes(['nan', 0, 10, 10], [0, 0, 10, 10]) },
  { id: 'a NaN in both axes', spec: boxes(['nan', 'nan', 10, 10], [0, 0, 10, 10]) },
  {
    id: 'an infinite width over a NaN height cannot be allocated',
    spec: boxes([0, 0, 'inf', 'nan']),
  },
  {
    id: 'boxes of infinite height that only touch do not overlap',
    spec: [shape('a', 0, 0, 10, 'inf'), shape('b', 10, 0, 10, 'inf')],
  },
  {
    id: 'boxes of infinite width that only touch do not overlap',
    spec: [shape('a', 0, 0, 'inf', 10), shape('b', 0, 10, 'inf', 10)],
  },
  {
    id: 'a NaN box among shapes',
    spec: [shape('a', 0, 0, 10, 10), shape('b', 'nan', 'nan', 'nan', 'nan')],
  },
  {
    id: 'a NaN box clusters with nothing',
    spec: [shape('a', 0, 0, 30, 30), shape('b', 5, 5, 'nan', 5), shape('c', 6, 6, 4, 4)],
  },
  {
    id: 'infinite boxes overlap and contain',
    spec: [shape('a', '-inf', '-inf', 'inf', 'inf'), shape('b', 0, 0, 10, 10)],
  },
  { id: 'the entry cap holds at 2000', spec: [{ t: 'g', b: [0, 0, 10, 10], r: 2000, d: [30, 0] }] },
  {
    id: 'one past the entry cap drops the pairwise fields',
    spec: [{ t: 'g', b: [0, 0, 10, 10], r: 2001, d: [30, 0] }],
  },
  {
    id: 'a chain of exactly the overlap cap',
    spec: [{ t: 'g', b: [0, 0, 10, 10], r: 1001, d: [9, 0] }],
  },
  {
    id: 'a chain one pair past the overlap cap',
    spec: [{ t: 'g', b: [0, 0, 10, 10], r: 1002, d: [9, 0] }],
  },
  { id: 'a stack past the overlap cap', spec: [{ t: 'g', b: [0, 0, 10, 10], r: 46 }] },
  { id: 'a stack under the overlap cap', spec: [{ t: 'g', b: [0, 0, 10, 10], r: 45 }] },
  { id: 'a stack with ids', spec: [{ t: 's', i: 'x', b: [0, 0, 10, 10], r: 12 }] },
  {
    id: 'exactly the region cap',
    spec: [shape('m', 20, 0, 20, 501 * 20), shape('l', 0, 0, 20, 20), shape('r', 40, 0, 20, 20)],
  },
  {
    id: 'a region past the cap',
    spec: [shape('m', 20, 0, 20, 502 * 20), shape('l', 0, 0, 20, 20), shape('r', 40, 0, 20, 20)],
  },
  {
    id: 'the regions kept past the cap are the largest, in position order',
    spec: [shape('m', 20, 0, 20, 601 * 20), shape('l', 0, 0, 20, 20), shape('r', 40, 0, 40, 20)],
  },
  {
    id: 'equal regions past the cap keep the first by position',
    spec: [shape('m', 20, 0, 20, 1002 * 20), shape('l', 0, 0, 20, 20), shape('r', 40, 0, 20, 20)],
  },
  {
    id: 'a stack covering the grid',
    spec: [{ t: 'g', b: [0, 0, 9980, 9980], r: 300 }, glyph(9980, 9980, 20, 20)],
  },
  {
    id: 'many boxes over the grid past the entry cap',
    spec: [{ t: 'g', b: [0, 0, 9980, 9980], r: 2100 }, glyph(9980, 9980, 20, 20)],
  },
]

/** Boards drawn once from a fixed seed and committed as data: a fixture's provenance, never a property seed. */
const SEEDED_FROM = 0x1d5e_ed01
const SEEDED_COUNT = 90

const seeded: readonly Case[] = (() => {
  const next = mulberry32(SEEDED_FROM)
  return Array.from({ length: SEEDED_COUNT }, (_, i) => ({
    id: `seeded ${i}`,
    spec: seededSpec(next),
  }))
})()

export const CASES: readonly Case[] = [...named, ...seeded]
