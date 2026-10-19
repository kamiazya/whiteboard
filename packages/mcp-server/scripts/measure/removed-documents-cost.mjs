/**
 * What finding the documents one workspace update removed costs the serving
 * loop — `documentsRemovedSince`, which a keeper runs synchronously on every
 * update that touches the tree, before the update is saved.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/removed-documents-cost.mjs [n ...]
 *
 * Each argument is a document count. Three shapes per count, each removing
 * every document in one update:
 * - `root`: n documents at the workspace root.
 * - `folder`: n documents in one folder.
 * - `parent`: n documents below one document, half of them moved out to the
 *   root by the same update that deletes the parent.
 * Times are the median of three calls, in milliseconds.
 */
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  documentsRemovedSince,
  moveWorkspaceNodeToPath,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'

const counts = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [500, 1000, 2000]

const id = (i) => `01BRW${String(i).padStart(21, '0')}`

function shape(name, n) {
  const doc = new LoroDoc()
  const at = (i) => (name === 'root' ? `d${i}` : `p/d${i}`)
  if (name === 'parent')
    createWorkspaceDocumentAtPath(doc, { path: 'p', documentId: id(n), kind: 'markdown' })
  for (let i = 0; i < n; i++) {
    createWorkspaceDocumentAtPath(doc, { path: at(i), documentId: id(i), kind: 'markdown' })
  }
  doc.commit()
  const since = doc.oplogVersion()
  if (name === 'root') for (let i = 0; i < n; i++) deleteWorkspaceNodeAtPath(doc, at(i))
  else {
    if (name === 'parent')
      for (let i = 0; i < n; i += 2) moveWorkspaceNodeToPath(doc, at(i), `m${i}`)
    deleteWorkspaceNodeAtPath(doc, 'p')
  }
  doc.commit()
  return { doc, since }
}

for (const n of counts) {
  for (const name of ['root', 'folder', 'parent']) {
    const { doc, since } = shape(name, n)
    const times = []
    let removed = 0
    for (let run = 0; run < 3; run++) {
      const start = performance.now()
      removed = documentsRemovedSince(doc, since).length
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    console.log(
      `${name.padEnd(6)} n=${String(n).padStart(5)} removed=${removed} ${times[1].toFixed(0)}ms`,
    )
  }
}
