// Pure layout helper that assigns x/y positions to nodes in a directed graph.
// It uses a minimal Sugiyama-style layered layout: derive ranks with a BFS
// longest-path approximation, spread nodes within the same rank, and keep a
// fixed gap between ranks. Cycles are tolerated without SCC decomposition.

export interface LayoutNode {
  id: string
  width: number
  height: number
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
}

// Optional layout pin for fixing rank and cross-axis ordering.
interface LayoutPin {
  id: string
  rank?: number
  anchor?: 'left' | 'right' | 'top' | 'bottom' | 'center'
  column?: number
}

// Optional grouping for laying out subgraphs independently before placing the
// groups side-by-side on the cross axis.
interface LayoutGroup {
  id: string
  elementIds: string[]
}

interface LayoutConfig {
  direction?: 'TB' | 'LR'
  // Gap between ranks. Default 80.
  layerGap?: number
  // Gap between nodes in the same rank. Default 40.
  nodeGap?: number
  // Top-left origin for the layout block.
  origin?: { x: number; y: number }
  // Pins for semantically meaningful rank placement.
  pins?: LayoutPin[]
  // Independent subgraph groups.
  groups?: LayoutGroup[]
  // Gap between groups on the cross axis. Default 80.
  groupGap?: number
}

export interface AutoLayoutInput {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  config?: LayoutConfig
}

export interface AutoLayoutResult {
  positions: Map<string, { x: number; y: number }>
}

export function resolveAutoLayout(input: AutoLayoutInput): AutoLayoutResult {
  // Lay out groups independently when present; otherwise compute one block.
  const groups = input.config?.groups
  if (groups && groups.length > 0) {
    return layoutWithGroups(input, groups)
  }
  return computeSingleBlock(input)
}

function computeSingleBlock(input: AutoLayoutInput): AutoLayoutResult {
  const direction = input.config?.direction ?? 'TB'
  const layerGap = input.config?.layerGap ?? 80
  const nodeGap = input.config?.nodeGap ?? 40
  const origin = input.config?.origin ?? { x: 0, y: 0 }

  // Build adjacency lists and indegree counts.
  const outEdges = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const node of input.nodes) {
    outEdges.set(node.id, [])
    inDegree.set(node.id, 0)
  }
  for (const edge of input.edges) {
    if (outEdges.has(edge.source) && inDegree.has(edge.target)) {
      outEdges.get(edge.source)!.push(edge.target)
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }
  }

  // Max rank is nodeCount - 1, used when interpreting anchors.
  const maxRank = Math.max(0, input.nodes.length - 1)

  // Resolve pins into numeric ranks. Unknown ids are ignored.
  const nodeIdSet = new Set(input.nodes.map((n) => n.id))
  const pinnedRank = new Map<string, number>()
  for (const pin of input.config?.pins ?? []) {
    if (!nodeIdSet.has(pin.id)) continue
    if (pin.rank !== undefined) {
      pinnedRank.set(pin.id, Math.max(0, Math.floor(pin.rank)))
      continue
    }
    if (pin.anchor === 'left' || pin.anchor === 'top') pinnedRank.set(pin.id, 0)
    else if (pin.anchor === 'right' || pin.anchor === 'bottom') pinnedRank.set(pin.id, maxRank)
    else if (pin.anchor === 'center') pinnedRank.set(pin.id, Math.floor(maxRank / 2))
  }

  // BFS longest-path approximation. Unreached nodes become rank 0 later.
  const rank = new Map<string, number>()
  const queue: string[] = []
  for (const node of input.nodes) {
    const pin = pinnedRank.get(node.id)
    if (pin !== undefined) {
      rank.set(node.id, pin)
      queue.push(node.id)
      continue
    }
    if ((inDegree.get(node.id) ?? 0) === 0) {
      rank.set(node.id, 0)
      queue.push(node.id)
    }
  }
  // Cycle-only graphs still need a starting point.
  if (queue.length === 0 && input.nodes.length > 0) {
    rank.set(input.nodes[0].id, 0)
    queue.push(input.nodes[0].id)
  }

  // Cap rank growth at nodeCount - 1 so cycles terminate.
  while (queue.length > 0) {
    const current = queue.shift()!
    const currentRank = rank.get(current) ?? 0
    for (const next of outEdges.get(current) ?? []) {
      if (pinnedRank.has(next)) continue // pinned nodes are not overwritten by BFS
      const prev = rank.get(next)
      const newRank = currentRank + 1
      if (newRank > maxRank) continue // cut off cycle growth
      if (prev === undefined || prev < newRank) {
        rank.set(next, newRank)
        queue.push(next)
      }
    }
  }
  // Unreached nodes from disconnected components also land in rank 0.
  for (const node of input.nodes) {
    if (!rank.has(node.id)) rank.set(node.id, 0)
  }

  // Bucket node ids by rank.
  const byRank = new Map<number, string[]>()
  for (const node of input.nodes) {
    const r = rank.get(node.id)!
    if (!byRank.has(r)) byRank.set(r, [])
    byRank.get(r)!.push(node.id)
  }

  // Apply column ordering within each rank. Column-specified nodes come first
  // in ascending column order; the rest keep original order afterward.
  const columnById = new Map<string, number>()
  for (const pin of input.config?.pins ?? []) {
    if (pin.column !== undefined && nodeIdSet.has(pin.id)) {
      columnById.set(pin.id, pin.column)
    }
  }
  for (const [r, ids] of byRank) {
    const withCol: { id: string; col: number; origIdx: number }[] = []
    const withoutCol: { id: string; origIdx: number }[] = []
    ids.forEach((id, idx) => {
      const col = columnById.get(id)
      if (col !== undefined) withCol.push({ id, col, origIdx: idx })
      else withoutCol.push({ id, origIdx: idx })
    })
    withCol.sort((a, b) => a.col - b.col || a.origIdx - b.origIdx)
    byRank.set(r, [...withCol.map((x) => x.id), ...withoutCol.map((x) => x.id)])
  }

  // Index node sizes by id.
  const nodeById = new Map<string, LayoutNode>()
  for (const node of input.nodes) nodeById.set(node.id, node)

  // Accumulate the primary-axis start for each rank.
  const ranks = [...byRank.keys()].sort((a, b) => a - b)
  const axisStarts = new Map<number, number>()
  let runningAxis = direction === 'TB' ? origin.y : origin.x
  for (const r of ranks) {
    const ids = byRank.get(r)!
    axisStarts.set(r, runningAxis)
    const axisSize =
      direction === 'TB'
        ? Math.max(...ids.map((id) => nodeById.get(id)!.height))
        : Math.max(...ids.map((id) => nodeById.get(id)!.width))
    runningAxis += axisSize + layerGap
  }

  // Within a rank, place nodes from the cross-axis origin in order.
  const positions = new Map<string, { x: number; y: number }>()
  for (const r of ranks) {
    const ids = byRank.get(r)!
    const axisTop = axisStarts.get(r)!
    const orthStart = direction === 'TB' ? origin.x : origin.y
    let running = orthStart
    for (const id of ids) {
      const node = nodeById.get(id)!
      if (direction === 'TB') {
        positions.set(id, { x: running, y: axisTop })
        running += node.width + nodeGap
      } else {
        positions.set(id, { x: axisTop, y: running })
        running += node.height + nodeGap
      }
    }
  }

  return { positions }
}

// Lay out each group independently, then place the resulting blocks along the
// cross axis. Unassigned nodes go into an implicit "__unassigned__" bucket.
function layoutWithGroups(input: AutoLayoutInput, groups: LayoutGroup[]): AutoLayoutResult {
  const direction = input.config?.direction ?? 'TB'
  const origin = input.config?.origin ?? { x: 0, y: 0 }
  const groupGap = input.config?.groupGap ?? 80

  // Assign node ids to group ids.
  const nodeIds = new Set(input.nodes.map((n) => n.id))
  const assignment = new Map<string, string>()
  for (const g of groups) {
    for (const id of g.elementIds) {
      if (nodeIds.has(id)) assignment.set(id, g.id)
    }
  }

  // Bucket order: implicit unassigned first, then groups in caller order.
  const buckets: { id: string; nodes: LayoutNode[] }[] = []
  const unassigned = input.nodes.filter((n) => !assignment.has(n.id))
  if (unassigned.length > 0) buckets.push({ id: '__unassigned__', nodes: unassigned })
  for (const g of groups) {
    const gnodes = input.nodes.filter((n) => assignment.get(n.id) === g.id)
    if (gnodes.length > 0) buckets.push({ id: g.id, nodes: gnodes })
  }

  const merged = new Map<string, { x: number; y: number }>()
  let crossOffset = 0

  for (const bucket of buckets) {
    const bucketNodeIds = new Set(bucket.nodes.map((n) => n.id))
    const bucketEdges = input.edges.filter(
      (e) => bucketNodeIds.has(e.source) && bucketNodeIds.has(e.target),
    )
    // Remove group config and lay this bucket out as a single block.
    const subInput: AutoLayoutInput = {
      nodes: bucket.nodes,
      edges: bucketEdges,
      config: {
        ...input.config,
        groups: undefined,
        origin: {
          x: direction === 'TB' ? origin.x + crossOffset : origin.x,
          y: direction === 'LR' ? origin.y + crossOffset : origin.y,
        },
      },
    }
    const sub = computeSingleBlock(subInput)

    // Measure the bucket extent on the cross axis.
    const bucketStart = direction === 'TB' ? origin.x + crossOffset : origin.y + crossOffset
    let bucketExtent = 0
    for (const [id, pos] of sub.positions) {
      merged.set(id, pos)
      const node = bucket.nodes.find((n) => n.id === id)!
      const end = direction === 'TB' ? pos.x + node.width : pos.y + node.height
      const extent = end - bucketStart
      if (extent > bucketExtent) bucketExtent = extent
    }
    crossOffset += bucketExtent + groupGap
  }

  return { positions: merged }
}
