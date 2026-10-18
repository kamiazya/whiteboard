/**
 * What linking a document's mentions costs inside ONE canvas node, by how
 * many mentions the node's text holds — the rewrite `wb_linkify_mentions`
 * and the web app's linkify run on every text node of a canvas.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/linkify-node-cost.mjs [mentions...]
 *
 * Each row is a canvas of one text node, then of 2000 (the most a canvas
 * holds), each node holding `mentions` mentions of a document named `N`
 * separated by a space — the densest text a mention can be packed into. Its
 * link, `[[n|N]]`, is six characters longer, so 1024 mentions is the most a
 * node can link under its 8 KiB text ceiling. The 2000-node column includes
 * the canvas write the rewrite ends in. Times are the median of nine calls
 * (one node) and three (2000), in milliseconds; a column that quadruples per doubling is quadratic, one
 * that doubles is linear.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { linkifyMentionsIn } from '../../../reference-graph/src/index.ts'

const BOARD_ID = '01BRWAAAAAAAAAAAAAAAAAAAA5'
const NODES = 2000
const args = process.argv.slice(2).map(Number)
const scales = args.length > 0 ? args : [128, 256, 512, 1024]
const target = { documentId: '01BRWAAAAAAAAAAAAAAAAAAAA6', path: 'n', name: 'N' }

function board(mentions, count) {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD_ID, kind: 'spatial' })
  const text = 'N '.repeat(mentions)
  const nodes = Array.from({ length: count }, (_, i) =>
    textNode({ id: `n${i}`, text, x: 0, y: 0, width: 100, height: 40 }),
  )
  const containers = documentContainers(doc, BOARD_ID)
  writeSpatialCanvas(containers, { nodes, edges: [] })
  doc.commit()
  return containers
}

function timeLinkify(mentions, nodes) {
  const containers = board(mentions, nodes)
  const start = performance.now()
  const linked = linkifyMentionsIn(containers, 'spatial', target)
  const ms = performance.now() - start
  if (linked !== mentions * nodes) throw new Error(`linked ${linked}, expected ${mentions * nodes}`)
  return ms
}

function median(fn, runs) {
  const times = Array.from({ length: runs }, fn).sort((a, b) => a - b)
  return times[Math.floor(runs / 2)]
}

// One warm-up pass, so the first row is not where the rewrite gets compiled.
timeLinkify(scales[0], 50)

console.log('mentions per node   ms, 1 node   ms, 2000 nodes')
for (const mentions of scales) {
  console.log(
    [
      String(mentions).padStart(17),
      median(() => timeLinkify(mentions, 1), 9)
        .toFixed(2)
        .padStart(13),
      median(() => timeLinkify(mentions, NODES), 3)
        .toFixed(1)
        .padStart(16),
    ].join(''),
  )
}
