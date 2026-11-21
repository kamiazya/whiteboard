/**
 * What one read of a workspace record costs, by the way it names the document,
 * over N documents of real prose: the entry by path, the entry by id, and a
 * read that names a document to answer from its content (`spatialNodeCount`,
 * `markdownBody`). Each call yields to the event loop after it, as a request
 * does, and the figure is the median of SAMPLES calls (30 by default), wall
 * milliseconds, at 90, 180, 360 and 720 documents.
 *
 * Why it yields. Loro hands every tree node it visits back as a wasm handle,
 * freed only after a collection and a turn of the event loop, so a loop that
 * never yields measures the handles piling up rather than the read: the first
 * version of this measurement, timing a tight loop, read 18, 107, 460 and 2134
 * ms for a whole listing across those counts and called it super-linear. Read
 * with a turn between calls, the same reads are linear in the nodes.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/tree-read-cost.mjs
 */
import { createRequire } from 'node:module'
import { corpusSnapshot } from './corpus-record.mjs'

const require = createRequire(import.meta.url)
const SAMPLES = Number(process.env.SAMPLES ?? 30)
const COUNTS = (process.env.COUNTS ?? '90,180,360,720').split(',').map(Number)
const asserted = { parse: (value) => value }
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]
const turn = () => new Promise((resolve) => setImmediate(resolve))

async function timeIt(fn) {
  await fn()
  const spent = []
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now()
    await fn()
    spent.push(performance.now() - t)
    await turn()
  }
  return Number(median(spent).toFixed(2))
}

const { LoroDoc } = require('loro-crdt')
const adapter = await import('@kamiazya/whiteboard-loro-adapter')

console.log('  docs   nodes   entry by path   entry by id   spatialNodeCount   markdownBody')
for (const count of COUNTS) {
  const { bytes } = await corpusSnapshot(count)
  const doc = LoroDoc.fromSnapshot(bytes)
  const session = adapter.bindRecordOps(adapter.legacyRecordOps, doc, async () => {})
  const listing = adapter.readWorkspaceDocuments(doc)
  const { path, documentId } = listing[listing.length >> 1]
  const read = (query, args) => () => session.read({ query, args }, asserted)
  const byPath = await timeIt(read('workspaceDocumentEntry', { path }))
  const byId = await timeIt(read('workspaceDocumentEntry', { documentId }))
  const nodeCount = await timeIt(read('spatialNodeCount', { documentId }))
  const body = await timeIt(read('markdownBody', { documentId }))
  console.log(
    `  ${String(count).padStart(4)}   ${String(adapter.readWorkspaceNodes(doc).length).padStart(5)}   ${String(byPath).padStart(13)}   ${String(byId).padStart(11)}   ${String(nodeCount).padStart(16)}   ${String(body).padStart(12)}`,
  )
}
process.exit(0)
