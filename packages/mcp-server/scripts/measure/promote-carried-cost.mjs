/**
 * What judging a promote's carried versions costs the serving loop, by how
 * many rows the request carries and how large the record they name is — the
 * work `judgeCarried` does synchronously before anything merges: a checkout
 * of the incoming record per row, a projection of the document it names, and
 * the sync surface's size judgement of that state.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/promote-carried-cost.mjs [nodes:rows ...]
 *
 * Each argument is one row: a canvas of `nodes` text nodes, judged under
 * `rows` carried versions. Two shapes per row:
 * - `same`: every row names ONE frontier — the shape a request can repeat
 *   until the body ceiling, since rows are a few hundred bytes each.
 * - `distinct`: each row names its own frontier, one commit apart, as a real
 *   browser history does.
 * Times are the median of three calls, in milliseconds.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { judgeCarried } from '../../../server-core/src/operations/promote-carried.ts'

const BOARD_ID = '01BRWAAAAAAAAAAAAAAAAAAAA5'
const rowsArg = process.argv.length > 2 ? process.argv.slice(2) : ['50:50', '50:200']
const shapes = rowsArg.map((row) => row.split(':').map(Number))

function box(id) {
  return textNode({ id, text: `node ${id}`, x: 0, y: 0, width: 100, height: 40 })
}

/** A record holding one canvas, edited `edits` times so it has that many past points. */
function record(nodes, edits) {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD_ID, kind: 'spatial' })
  const canvas = { nodes: Array.from({ length: nodes }, (_, i) => box(`n${i}`)), edges: [] }
  writeSpatialCanvas(documentContainers(doc, BOARD_ID), canvas)
  doc.commit()
  const points = []
  for (let i = 0; i < edits; i++) {
    points.push(encodeFrontiers(doc.oplogFrontiers()))
    const moved = { ...canvas, nodes: canvas.nodes.map((n, j) => (j === 0 ? { ...n, x: i } : n)) }
    writeSpatialCanvas(documentContainers(doc, BOARD_ID), moved)
    doc.commit()
  }
  const incoming = new LoroDoc()
  incoming.import(doc.export({ mode: 'snapshot' }))
  return { incoming, points }
}

function row(id, frontiers) {
  return { id, documentId: BOARD_ID, createdAt: 1, auto: true, frontiers }
}

async function median(fn) {
  const times = []
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    await fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return times[1]
}

console.log('nodes    rows    same ms   distinct ms')
for (const [nodes, rows] of shapes) {
  const { incoming, points } = record(nodes, rows)
  const first = points[0]
  const same = Array.from({ length: rows }, (_, i) => row(`s${i}`, first))
  const distinct = points.map((frontiers, i) => row(`d${i}`, frontiers))
  const judge = (versions) => async () => {
    const judged = await judgeCarried(incoming, { trash: [], versions })
    if (judged.kind !== 'admitted') throw new Error(`refused: ${judged.reason}`)
  }
  console.log(
    [
      String(nodes).padStart(5),
      String(rows).padStart(8),
      (await median(judge(same))).toFixed(1).padStart(11),
      (await median(judge(distinct))).toFixed(1).padStart(14),
    ].join(''),
  )
}
