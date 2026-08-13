import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'

/**
 * The canvases that reached a human before they reached the suite. Each one
 * is a routing defect someone had to notice and report; keeping them together
 * makes "did this change help overall" a question with an answer, instead of
 * one pin per fix judged on its own.
 *
 * Every case is the same shape — two overlapping boxes plus a third above —
 * because that is the arrangement the router kept getting wrong, and the
 * horizontal offset between the two is what separates them.
 */
export type RoutingCase = {
  readonly name: string
  readonly nodes: readonly SpatialNode[]
  readonly edges: readonly CanvasEdge[]
}

const node = (id: string, x: number, y: number, w: number, h: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width: w,
  height: h,
  text: id,
})

const overlappingPair = (name: string, bx: number, by: number): RoutingCase => ({
  name,
  nodes: [node('A', 100, 570, 200, 100), node('B', bx, by, 200, 100), node('T', 80, 360, 200, 110)],
  edges: [
    { id: 'e_AB', fromNode: 'A', toNode: 'B' },
    { id: 'e_TA', fromNode: 'T', toNode: 'A', label: 'hoge' },
    { id: 'e_TB', fromNode: 'T', toNode: 'B' },
  ],
})

export const ROUTING_CORPUS: readonly RoutingCase[] = [
  // The edge ran along the source's own border, indistinguishable from it.
  overlappingPair('reported: edge traced the source border', 220, 520),
  // The route hooked past its anchor and doubled back, reading as a loop.
  overlappingPair('reported: edge looped at the arrival', 246, 510),
  // The route cut 170px straight through the target's body.
  overlappingPair('reported: edge tunnelled through the target', 280, 520),
  {
    name: 'nested: an edge between two members of a frame',
    nodes: [
      node('frame', 0, 0, 400, 300),
      node('inner1', 40, 40, 100, 60),
      node('inner2', 240, 180, 100, 60),
    ],
    edges: [{ id: 'e_inner', fromNode: 'inner1', toNode: 'inner2' }],
  },
  {
    name: 'corridor: a third node sits between the endpoints',
    nodes: [node('L', 0, 100, 120, 80), node('M', 200, 60, 100, 160), node('R', 380, 100, 120, 80)],
    edges: [{ id: 'e_LR', fromNode: 'L', toNode: 'R' }],
  },
]

/**
 * A fixed synthetic corpus for the aggregate count. Deliberately NOT a
 * fast-check property: the routing defects are widespread enough that the
 * honest assertion today is a pinned total, and a total is only meaningful
 * if the layouts behind it never change. `mulberry32` makes the whole corpus
 * a pure function of its index.
 *
 * Boxes are large relative to the coordinate range on purpose — the defects
 * only appear when nodes crowd each other, so a generator that spread them
 * out would report a clean score while drawing the same broken pictures.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function syntheticLayouts(count: number): readonly RoutingCase[] {
  const random = mulberry32(0x5eed)
  const int = (max: number) => Math.floor(random() * max)
  const cases: RoutingCase[] = []
  for (let i = 0; cases.length < count; i++) {
    const size = 2 + int(4)
    const nodes = Array.from({ length: size }, (_, n) =>
      node(`n${n}`, int(401), int(401), 60 + int(141), 40 + int(121)),
    )
    const edges: CanvasEdge[] = []
    for (let a = 0; a < size; a++) {
      for (let b = a + 1; b < size; b++) {
        if (int(2) === 1) edges.push({ id: `e${a}_${b}`, fromNode: `n${a}`, toNode: `n${b}` })
      }
    }
    if (edges.length > 0) cases.push({ name: `synthetic ${i}`, nodes, edges })
  }
  return cases
}
