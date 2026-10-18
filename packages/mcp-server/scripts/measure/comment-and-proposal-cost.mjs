/**
 * What a canvas's comment threads and open proposed changes cost one layout,
 * by how many it holds — the overlay every `wb_scene_render`, export and
 * editor preview lays out again on top of the board, and what the
 * per-document thread and open-change ceilings are sized against.
 *
 * Run:
 *   [NODES=300] [CHANGES_PER_PROPOSAL=1] node --import tsx/esm \
 *     scripts/measure/comment-and-proposal-cost.mjs [threads:changes ...]
 *
 * Each argument is one row: `500:0` lays out 500 open comments and no
 * proposal, `0:500` no comment and 500 open changes, `500:500` both, and
 * `0:0` the board alone. The
 * board is `NODES` boxes on a grid; each comment is about one of them, and
 * each change patches one (moves it), in proposals of `CHANGES_PER_PROPOSAL`
 * changes. Layout runs as `wb_scene_render` runs it: the daemon's own text
 * measurer and the light theme. Each row is one call, CPU milliseconds, after
 * one warm-up call.
 *
 * Each proposal with an open change draws one bubble, placed against every
 * box and earlier bubble, so `CHANGES_PER_PROPOSAL=1` is the expensive shape
 * and a few large proposals the cheap one.
 */
import { createSpatialTheme, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { createExportTextMeasurer } from '../../src/server/export/measure-text.ts'

const nodeCount = Number(process.env.NODES ?? 300)
const perProposal = Number(process.env.CHANGES_PER_PROPOSAL ?? 1)
const rows = (process.argv.length > 2 ? process.argv.slice(2) : ['100:0', '0:100']).map((row) =>
  row.split(':').map(Number),
)
const appearance = createSpatialTheme({ mode: 'light' })
const { measure } = await createExportTextMeasurer({ fontsDir: '/nonexistent-fonts-dir' })

function board(count) {
  const perRow = Math.ceil(Math.sqrt(count))
  return {
    nodes: Array.from({ length: count }, (_, i) =>
      textNode({
        id: `n${i}`,
        x: (i % perRow) * 320,
        y: Math.floor(i / perRow) * 240,
        width: 200,
        height: 100,
        text: `n${i}`,
      }),
    ),
    edges: [],
  }
}

function comments(canvas, count) {
  return Array.from({ length: count }, (_, i) => {
    const node = canvas.nodes[i % canvas.nodes.length]
    return {
      id: `c${i}`,
      x: node.x + node.width,
      y: node.y,
      text: `Comment ${i}: is this box where it should be?`,
      targetNodeId: node.id,
    }
  })
}

function proposals(canvas, count) {
  const out = []
  for (let i = 0; i < count; i += perProposal) {
    const changes = []
    for (let k = i; k < Math.min(count, i + perProposal); k += 1) {
      const node = canvas.nodes[k % canvas.nodes.length]
      changes.push({
        id: `ch${k}`,
        status: 'open',
        op: 'node.patch',
        nodeId: node.id,
        patch: { x: node.x + 40 },
        assumed: { x: node.x },
      })
    }
    out.push({ id: `p${i}`, changes })
  }
  return out
}

function cpuMs(run) {
  const before = process.cpuUsage()
  run()
  const spent = process.cpuUsage(before)
  return (spent.user + spent.system) / 1000
}

const layOut = (canvas, options = {}) =>
  cpuMs(() => layoutSpatialCanvas(canvas, { measure, appearance, ...options }))

const warm = board(24)
layOut({ ...warm, comments: comments(warm, 10) }, { proposals: proposals(warm, 10) })

const canvas = board(nodeCount)
console.log(' nodes threads changes  layout ms')
for (const [threads, changes] of rows) {
  const ms = layOut(
    { ...canvas, comments: comments(canvas, threads) },
    { proposals: proposals(canvas, changes) },
  )
  console.log(
    `${String(nodeCount).padStart(6)} ${String(threads).padStart(7)} ${String(changes).padStart(7)} ${ms.toFixed(0).padStart(10)}`,
  )
}
