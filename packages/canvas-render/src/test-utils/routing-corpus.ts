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

/**
 * One large canvas with REAL LOCALITY — the shape an AI-authored document
 * grows into, and the case every other instrument in this package is blind
 * to.
 *
 * The bench's `gridCanvas` wires nodes by a stride, so every edge spans the
 * whole canvas and each one's bounding box overlaps roughly half the others
 * (measured: 55% of pairs survive the broad phase). That is the worst case
 * for any spatial pruning, and it is not what a real document looks like:
 * work clusters, and so do the edges between it. Optimising against the
 * stride canvas alone would price a spatial index at its least favourable
 * input and reject it for the wrong reason.
 *
 * So: `clusters` groups of nodes laid out in well-separated regions, with
 * `crossClusterRatio` of the edges reaching between neighbouring groups and
 * the rest staying local. Deterministic for a given seed, like every other
 * generator here.
 */
export function clusteredLayout(options: {
  readonly clusters: number
  readonly nodesPerCluster: number
  readonly edgesPerCluster: number
  readonly crossClusterRatio?: number
  readonly seed?: number
}): RoutingCase {
  const { clusters, nodesPerCluster, edgesPerCluster } = options
  const crossClusterRatio = options.crossClusterRatio ?? 0.15
  const random = mulberry32(options.seed ?? 0xc105)
  const int = (max: number) => Math.floor(random() * max)

  // Cluster regions on a square grid, spaced far enough apart that a local
  // edge cannot reach a neighbouring region — that separation is the whole
  // point of the fixture.
  const perRow = Math.ceil(Math.sqrt(clusters))
  const REGION_PX = 1200
  const nodes: SpatialNode[] = []
  for (let c = 0; c < clusters; c++) {
    const ox = (c % perRow) * REGION_PX
    const oy = Math.floor(c / perRow) * REGION_PX
    for (let n = 0; n < nodesPerCluster; n++) {
      nodes.push(node(`c${c}n${n}`, ox + int(700), oy + int(700), 120 + int(120), 60 + int(80)))
    }
  }

  const edges: CanvasEdge[] = []
  const seen = new Set<string>()
  const push = (from: string, to: string) => {
    if (from === to) return
    const key = `${from}->${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ id: `e${edges.length}`, fromNode: from, toNode: to })
  }
  for (let c = 0; c < clusters; c++) {
    for (let e = 0; e < edgesPerCluster; e++) {
      // A cross-cluster edge reaches the NEXT region only; a document's
      // long-range links are few and mostly between neighbours.
      if (random() < crossClusterRatio && clusters > 1) {
        const other = (c + 1) % clusters
        push(`c${c}n${int(nodesPerCluster)}`, `c${other}n${int(nodesPerCluster)}`)
      } else {
        push(`c${c}n${int(nodesPerCluster)}`, `c${c}n${int(nodesPerCluster)}`)
      }
    }
  }
  return { name: `clustered ${clusters}x${nodesPerCluster}`, nodes, edges }
}
