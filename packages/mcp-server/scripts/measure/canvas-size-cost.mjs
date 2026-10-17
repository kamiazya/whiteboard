/**
 * What one canvas costs the daemon to lay out and to tidy, by how many nodes
 * and edges it holds — the work every render, export and layout read repeats
 * on the serving loop, and what the per-canvas node and edge ceilings are
 * sized against.
 *
 * Run:
 *   [EDGES_PER_CLUSTER=12] [ONLY=layout|tidy] node --import tsx/esm \
 *     scripts/measure/canvas-size-cost.mjs [nodeCounts...]
 *
 * The canvas is clusters of twelve boxes, far enough apart that an edge
 * inside one cannot reach the next, with `EDGES_PER_CLUSTER` edges inside each
 * and roughly one in seven reaching another cluster — the shape a real board
 * takes, rather than a grid of edges that all span it. `EDGES_PER_CLUSTER=0`
 * keeps two edges only, which prices the node half of layout alone.
 *
 * Layout runs as `wb_scene_render` runs it: the daemon's own text measurer and
 * the light theme. Tidy runs as `wb_canvas_edit`'s tidy op runs it, over every
 * box. Each row is one call, CPU milliseconds, after one warm-up call on a
 * small canvas so module load and font tables are not in the first row.
 */
import {
  createSpatialTheme,
  layoutSpatialCanvas,
  tidyBoxes,
  tidyNodes,
} from '@kamiazya/whiteboard-canvas-render'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { createExportTextMeasurer } from '../../src/server/export/measure-text.ts'

const counts = process.argv.slice(2).map(Number)
const nodeCounts = counts.length > 0 ? counts : [300, 1000, 2000]
const edgesPerCluster = Number(process.env.EDGES_PER_CLUSTER ?? 12)
const only = process.env.ONLY
const appearance = createSpatialTheme({ mode: 'light' })
const { measure } = await createExportTextMeasurer({ fontsDir: '/nonexistent-fonts-dir' })

/** A deterministic generator, so two runs lay out the same canvas. */
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
  const push = (from, to) => {
    const key = `${from}->${to}`
    if (from === to || seen.has(key)) return
    seen.add(key)
    edges.push({ id: `e${edges.length}`, from: { node: from }, to: { node: to } })
  }
  if (edgesPerCluster === 0) {
    push(nodes[0].id, nodes[1].id)
    push(nodes.at(-1).id, nodes[0].id)
  } else {
    for (let c = 0; c < clusters; c++) {
      const members = nodes.filter((node) => node.id.startsWith(`c${c}n`))
      for (let e = 0; e < edgesPerCluster; e++) {
        const from = members[int(members.length)].id
        const to = random() < 0.15 ? nodes[int(nodes.length)].id : members[int(members.length)].id
        push(from, to)
      }
    }
  }
  return { nodes, edges }
}

function cpuMs(run) {
  const before = process.cpuUsage()
  run()
  const spent = process.cpuUsage(before)
  return (spent.user + spent.system) / 1000
}

const layOut = (canvas) => cpuMs(() => layoutSpatialCanvas(canvas, { measure, appearance }))
const tidy = (canvas) => cpuMs(() => tidyNodes(tidyBoxes(canvas.nodes), { edges: canvas.edges }))

const warm = clusteredCanvas(24)
layOut(warm)
tidy(warm)

console.log(' nodes  edges  layout ms    tidy ms')
for (const count of nodeCounts) {
  const canvas = clusteredCanvas(count)
  const layoutMs = only === 'tidy' ? NaN : layOut(canvas)
  const tidyMs = only === 'layout' ? NaN : tidy(canvas)
  console.log(
    `${String(canvas.nodes.length).padStart(6)} ${String(canvas.edges.length).padStart(6)} ${layoutMs.toFixed(0).padStart(10)} ${tidyMs.toFixed(0).padStart(10)}`,
  )
}
