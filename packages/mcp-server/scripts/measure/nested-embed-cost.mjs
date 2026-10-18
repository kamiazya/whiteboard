/**
 * What one render costs when a hub board's file nodes all name the SAME large
 * board and every one is expanded into its miniature — `wb_scene_render` with
 * `embedReferences`, or the viewer's previews. The nested-layout budget is
 * spent per embed, so this prices what one render can be made to lay out.
 *
 * Run:
 *   node --import tsx/esm scripts/measure/nested-embed-cost.mjs [boardNodes] [hubCounts...]
 *
 * The named board is `canvas-size-cost.mjs`'s clustered shape (about one edge
 * per node). Each row is one render through the daemon's own measurer and the
 * light theme, CPU milliseconds, after one warm-up render. `embeds` counts the
 * miniatures drawn; `elements` the nodes, edges and lines those miniatures
 * laid out — the count the budget is meant to bound.
 */
import { createSpatialTheme, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { createExportTextMeasurer } from '../../src/server/export/measure-text.ts'

const [boardArg, ...hubArgs] = process.argv.slice(2).map(Number)
const boardNodes = boardArg ?? 300
const hubCounts = hubArgs.length > 0 ? hubArgs : [1, 4, 16]
const appearance = createSpatialTheme({ mode: 'light' })
const { measure } = await createExportTextMeasurer({ fontsDir: '/nonexistent-fonts-dir' })

function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function clusteredCanvas(nodeCount) {
  const random = seeded(0xc105)
  const int = (max) => Math.floor(random() * max)
  const perCluster = 12
  const clusters = Math.ceil(nodeCount / perCluster)
  const perRow = Math.ceil(Math.sqrt(clusters))
  const nodes = []
  for (let c = 0; c < clusters; c++) {
    const ox = (c % perRow) * 1200
    const oy = Math.floor(c / perRow) * 1200
    for (let n = 0; n < perCluster && nodes.length < nodeCount; n++) {
      nodes.push(
        textNode({
          id: `c${c}n${n}`,
          x: ox + int(700),
          y: oy + int(700),
          width: 120 + int(120),
          height: 60 + int(80),
          text: `c${c}n${n}`,
        }),
      )
    }
  }
  const edges = []
  const seen = new Set()
  for (let c = 0; c < clusters; c++) {
    const members = nodes.filter((node) => node.id.startsWith(`c${c}n`))
    for (let e = 0; e < perCluster; e++) {
      const from = members[int(members.length)].id
      const to = random() < 0.15 ? nodes[int(nodes.length)].id : members[int(members.length)].id
      const key = `${from}->${to}`
      if (from === to || seen.has(key)) continue
      seen.add(key)
      edges.push({ id: `e${edges.length}`, from: { node: from }, to: { node: to } })
    }
  }
  return { nodes, edges }
}

function hub(count) {
  return {
    nodes: Array.from({ length: count }, (_, i) =>
      fileNode({
        id: `f${i}`,
        x: (i % 16) * 320,
        y: Math.floor(i / 16) * 260,
        width: 300,
        height: 240,
        file: 'B',
      }),
    ),
    edges: [],
  }
}

function cpuMs(run) {
  const before = process.cpuUsage()
  run()
  const spent = process.cpuUsage(before)
  return (spent.user + spent.system) / 1000
}

function countEmbeds(nodes) {
  let total = 0
  const visit = (node) => {
    if (node.kind === 'embedResolved') total += 1
    for (const child of node.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return total
}

const board = clusteredCanvas(boardNodes)
const boardElements = board.nodes.length + board.edges.length
const render = (canvas) => {
  let scene
  const ms = cpuMs(() => {
    scene = layoutSpatialCanvas(canvas, {
      measure,
      appearance,
      resolveReference: () => ({ canvas: board }),
      expandFileNode: () => true,
    })
  })
  return { ms, embeds: countEmbeds(scene.nodes) }
}

render(hub(1))

console.log(`board: ${board.nodes.length} nodes, ${board.edges.length} edges`)
console.log('   hub  embeds   elements  render ms')
for (const count of hubCounts) {
  const { ms, embeds } = render(hub(count))
  console.log(
    `${String(count).padStart(6)} ${String(embeds).padStart(7)} ${String(embeds * boardElements).padStart(10)} ${ms.toFixed(0).padStart(10)}`,
  )
}
