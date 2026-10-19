/**
 * What finding the documents one workspace update removed costs the serving
 * loop — `documentsRemovedSince`, which a keeper runs synchronously on every
 * update that touches the tree, before the update is saved.
 *
 * Run (from packages/mcp-server):
 *   node --expose-gc --import tsx/esm scripts/measure/removed-documents-cost.mjs [n ...]
 *
 * Each argument is a document count. Three shapes per count, each removing
 * every document in one update and each measured in a process of its own:
 * - `root`: n documents at the workspace root.
 * - `folder`: n documents in one folder.
 * - `parent`: n documents below one document, half of them moved out to the
 *   root by the same update that deletes the parent.
 * Each line is one call: wall and CPU milliseconds.
 *
 * The record is built with raw tree operations rather than the workspace
 * helpers, which resolve paths from the root on every create: building 1000
 * documents that way materialises a million tree-node handles, and the wasm
 * engine stays slower for the whole process afterwards (10x on unrelated
 * calls, measured), which would be charged to the call under measurement.
 * One process per shape for the same reason: the export handles one call
 * leaves behind slowed the next shape's call 3x when they shared a process.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { documentsRemovedSince, WORKSPACE_TREE_KEY } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'

const id = (i) => `01BRW${String(i).padStart(21, '0')}`

function place(tree, parent, documentId, segment) {
  const node = parent === undefined ? tree.createNode() : tree.createNode(parent)
  node.data.set('documentId', documentId)
  node.data.set('segment', segment)
  node.data.set('kind', 'markdown')
  node.data.set('createdAt', 0)
  node.data.set('updatedAt', 0)
  return node.id
}

function shape(name, n) {
  const doc = new LoroDoc()
  const tree = doc.getTree(WORKSPACE_TREE_KEY)
  let holder
  if (name === 'folder') {
    holder = tree.createNode()
    holder.data.set('segment', 'f')
  } else if (name === 'parent') holder = { id: place(tree, undefined, id(n), 'p') }
  const ids = Array.from({ length: n }, (_, i) => place(tree, holder?.id, id(i), `d${i}`))
  doc.commit()
  const since = doc.oplogVersion()
  if (name === 'root') for (const each of ids) tree.delete(each)
  else {
    if (name === 'parent') for (let i = 0; i < n; i += 2) tree.move(ids[i])
    tree.delete(holder.id)
  }
  doc.commit()
  return { doc, since }
}

function measure(name, n) {
  const { doc, since } = shape(name, n)
  globalThis.gc?.()
  const cpu = process.cpuUsage()
  const start = performance.now()
  const removed = documentsRemovedSince(doc, since).length
  const wall = performance.now() - start
  const used = process.cpuUsage(cpu)
  console.log(
    `${name.padEnd(6)} n=${String(n).padStart(5)} removed=${String(removed).padStart(5)}` +
      ` wall ${wall.toFixed(0)}ms cpu ${((used.user + used.system) / 1000).toFixed(0)}ms`,
  )
}

const [child, childN] = (process.env.REMOVED_DOCUMENTS_COST ?? '').split(':')
if (child !== '') {
  measure(child, Number(childN))
} else {
  const counts = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [500, 1000, 2000]
  for (const n of counts) {
    for (const name of ['root', 'folder', 'parent']) {
      spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
        stdio: 'inherit',
        env: { ...process.env, REMOVED_DOCUMENTS_COST: `${name}:${n}` },
      })
    }
  }
}
