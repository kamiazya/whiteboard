import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode } from '@kamiazya/whiteboard-model/test-utils'
import { styleRandomFromSeed } from '../layout/seed.js'
import { node } from './spatial-node.js'

/**
 * The documents that reached a human before they reached the suite. Each one
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

const overlappingPair = (name: string, bx: number, by: number): RoutingCase => ({
  name,
  nodes: [node('A', 100, 570, 200, 100), node('B', bx, by, 200, 100), node('T', 80, 360, 200, 110)],
  edges: [
    {
      id: 'e_AB',
      from: { node: 'A' },
      to: { node: 'B' },
    },
    {
      id: 'e_TA',
      from: { node: 'T' },
      to: { node: 'A' },
      label: 'hoge',
    },
    {
      id: 'e_TB',
      from: { node: 'T' },
      to: { node: 'B' },
    },
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
    edges: [
      {
        id: 'e_inner',
        from: { node: 'inner1' },
        to: { node: 'inner2' },
      },
    ],
  },
  {
    name: 'corridor: a third node sits between the endpoints',
    nodes: [node('L', 0, 100, 120, 80), node('M', 200, 60, 100, 160), node('R', 380, 100, 120, 80)],
    edges: [
      {
        id: 'e_LR',
        from: { node: 'L' },
        to: { node: 'R' },
      },
    ],
  },
]

/**
 * A fixed synthetic corpus for the aggregate count. Deliberately NOT a
 * fast-check property: the routing defects are widespread enough that the
 * honest assertion today is a pinned total, and a total is only meaningful
 * if the layouts behind it never change. `styleRandomFromSeed` (mulberry32) makes the whole corpus
 * a pure function of its index.
 *
 * Boxes are large relative to the coordinate range on purpose — the defects
 * only appear when nodes crowd each other, so a generator that spread them
 * out would report a clean score while drawing the same broken pictures.
 */
export function syntheticLayouts(count: number): readonly RoutingCase[] {
  const random = styleRandomFromSeed(0x5eed)
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
        if (int(2) === 1)
          edges.push({
            id: `e${a}_${b}`,
            from: { node: `n${a}` },
            to: { node: `n${b}` },
          })
      }
    }
    if (edges.length > 0) cases.push({ name: `synthetic ${i}`, nodes, edges })
  }
  return cases
}

/**
 * Boards a person lays out: equal boxes on a lattice, edges between random
 * pairs. Alignment is the point. Random positions almost never put two
 * detours on the same lane, so the synthetic corpus cannot show the defects
 * that appear only when boxes line up - two edges bending at one corner,
 * runs sharing a margin lane - and those are what a tidy diagram is full of.
 */
export function latticeLayouts(count: number): readonly RoutingCase[] {
  const random = styleRandomFromSeed(0x1a771ce)
  const int = (max: number) => Math.floor(random() * max)
  const COLUMNS = 5
  const ROWS = 3
  const cases: RoutingCase[] = []
  for (let i = 0; cases.length < count; i++) {
    const sites = Array.from({ length: COLUMNS * ROWS }, (_, site) => site)
    const size = 5 + int(4)
    const chosen: number[] = []
    for (let n = 0; n < size; n++) chosen.push(sites.splice(int(sites.length), 1)[0] as number)
    const nodes = chosen.map((site, n) =>
      node(`n${n}`, (site % COLUMNS) * 288 + 96, Math.floor(site / COLUMNS) * 200 + 96, 200, 100),
    )
    const edges: CanvasEdge[] = []
    const seen = new Set<string>()
    for (let e = 0; e < size + 2; e++) {
      const a = int(size)
      const b = int(size)
      const key = `${a}->${b}`
      if (a === b || seen.has(key)) continue
      seen.add(key)
      edges.push({ id: `e${a}_${b}`, from: { node: `n${a}` }, to: { node: `n${b}` } })
    }
    if (edges.length > 1) cases.push({ name: `lattice ${i}`, nodes, edges })
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
  const random = styleRandomFromSeed(options.seed ?? 0xc105)
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
    edges.push({
      id: `e${edges.length}`,
      from: { node: from },
      to: { node: to },
    })
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

/** The two-tier service board (8 nodes in 2 frames) the designer persona reported. */
export function designerBoard(): { nodes: SpatialNode[]; edges: CanvasEdge[] } {
  const box = (id: string, x: number, y: number) => node(id, x, y, 200, 100)
  return {
    nodes: [
      groupNode({ id: 'edgeTier', x: 60, y: 60, width: 1120, height: 180, label: 'Edge tier' }),
      groupNode({ id: 'coreTier', x: 60, y: 280, width: 1120, height: 160, label: 'Core tier' }),
      box('web', 96, 96),
      box('api', 384, 96),
      box('auth', 664, 96),
      box('payments', 944, 96),
      box('customer', 96, 312),
      box('orders', 384, 312),
      box('queue', 664, 312),
      box('db', 944, 312),
    ],
    edges: [
      { id: 'e_api_queue', from: { node: 'api' }, to: { node: 'queue' } },
      { id: 'e_queue_db', from: { node: 'queue' }, to: { node: 'db' }, label: 'persist' },
      { id: 'e_web_api', from: { node: 'web' }, to: { node: 'api' } },
      { id: 'e_customer_web', from: { node: 'customer' }, to: { node: 'web' }, label: 'HTTPS' },
      { id: 'e_orders_queue', from: { node: 'orders' }, to: { node: 'queue' }, label: 'publish' },
      { id: 'e_auth_orders', from: { node: 'auth' }, to: { node: 'orders' } },
    ],
  }
}

/**
 * Two frames of notes stacked one above the other, with connections running
 * between them — the board a designer sketches on a tablet, where an edge
 * between the frames has other notes and the lower frame's title in its way.
 * Notes sit on a grid inside each frame, as people place them.
 */
export function stackedFramesBoard(): { nodes: SpatialNode[]; edges: CanvasEdge[] } {
  const note = (id: string, x: number, y: number) => node(id, x, y, 160, 100)
  return {
    nodes: [
      groupNode({ id: 'ideas', x: 0, y: 0, width: 640, height: 300, label: 'Ideas' }),
      groupNode({
        id: 'actions',
        x: 0,
        y: 380,
        width: 640,
        height: 300,
        label: 'Next actions agreed with the team',
      }),
      note('a1', 40, 40),
      note('a2', 240, 40),
      note('a3', 440, 40),
      note('a4', 40, 170),
      note('a5', 240, 170),
      note('a6', 440, 170),
      note('b1', 40, 420),
      note('b2', 240, 420),
      note('b3', 440, 420),
      note('b4', 40, 550),
      note('b5', 240, 550),
      note('b6', 440, 550),
    ],
    edges: [
      { id: 'a1_b6', from: { node: 'a1' }, to: { node: 'b6' } },
      { id: 'a2_b5', from: { node: 'a2' }, to: { node: 'b5' } },
      { id: 'a3_b1', from: { node: 'a3' }, to: { node: 'b1' } },
      { id: 'a5_b2', from: { node: 'a5' }, to: { node: 'b2' } },
    ],
  }
}

/**
 * Generated boards of the `stackedFramesBoard` shape: two frames, one above
 * the other, each holding notes on a 3x2 grid, with connections mostly
 * running between the frames. Titles vary in length, because whether a
 * route crosses one depends on how far it reaches along the frame's top.
 */
export function stackedFrameLayouts(count: number): readonly RoutingCase[] {
  const random = styleRandomFromSeed(0xf4a3e5)
  const int = (max: number) => Math.floor(random() * max)
  const TITLES = ['Ideas', 'Actions', 'Open questions', 'Research findings from interviews', 'Q3']
  const cases: RoutingCase[] = []
  for (let i = 0; cases.length < count; i++) {
    const gap = 60 + int(80)
    const frameH = 300
    const nodes: SpatialNode[] = [
      groupNode({
        id: 'top',
        x: 0,
        y: 0,
        width: 640,
        height: frameH,
        label: TITLES[int(5)] ?? 'Ideas',
      }),
      groupNode({
        id: 'bottom',
        x: 0,
        y: frameH + gap,
        width: 640,
        height: frameH,
        label: TITLES[int(5)] ?? 'Actions',
      }),
    ]
    const members: string[][] = [[], []]
    for (const [f, oy] of [
      [0, 0],
      [1, frameH + gap],
    ] as const) {
      for (let site = 0; site < 6; site++) {
        if (int(4) === 0) continue
        const id = `${f === 0 ? 't' : 'b'}${site}`
        nodes.push(node(id, 40 + (site % 3) * 200, oy + 40 + Math.floor(site / 3) * 130, 160, 100))
        members[f]?.push(id)
      }
    }
    const [upper, lower] = members as [string[], string[]]
    const edges: CanvasEdge[] = []
    const seen = new Set<string>()
    for (let e = 0; e < 3 + int(4); e++) {
      const within = int(4) === 0
      const pool = within ? (int(2) === 0 ? upper : lower) : undefined
      const from = pool !== undefined ? pool[int(pool.length)] : upper[int(upper.length)]
      const to = pool !== undefined ? pool[int(pool.length)] : lower[int(lower.length)]
      if (from === undefined || to === undefined || from === to) continue
      const key = `${from}->${to}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ id: `e_${from}_${to}`, from: { node: from }, to: { node: to } })
    }
    if (edges.length > 0) cases.push({ name: `stacked frames ${i}`, nodes, edges })
  }
  return cases
}
