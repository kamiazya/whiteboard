/**
 * What it costs one process to FOLLOW a workspace record another process
 * writes — the two prices the daemon's default workspace tail and a stdio
 * process's read-through stamp each charge.
 *
 * Run:
 *   node --import tsx/esm scripts/measure/workspace-follow-cost.mjs
 *
 * Over a FILE-backed libSQL store through the production dialect, because an
 * in-memory one reads a different number (workspace-tail-loop-availability's
 * comment records 6.6ms against 8.1ms on one fixture) and the number that
 * matters is the one a daemon pays beside its own requests.
 *
 *   stamp      one `readFrontier` and a version-vector compare — the cheap
 *              persisted position a reader compares its in-memory copy to,
 *              to decide whether that copy is still the record. Charged on
 *              every access that would otherwise trust the cache.
 *   cursor     one `readCursor` (a four-read transaction), for contrast: it
 *              is what a tail pass pays per workspace to catch up.
 *   idle pass  one tail pass over N subscribed workspaces with nothing new
 *              written: the steady state, which is nearly every pass.
 *   gain pass  the same with one remote one-node edit in each workspace.
 *
 * THE PREFLIGHT IS NOT CEREMONY. A harness whose passes silently do nothing
 * keeps printing small, plausible numbers, so the gain pass must emit and the
 * idle pass must not, or the run exits 1.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId, newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { sql } from 'kysely'
import { LoroDoc, VersionVector } from 'loro-crdt'
import { createIsolatedDb } from '../../src/server/store/db/test-helpers.ts'
import { LibsqlDocumentStore } from '../../src/server/store/libsql/libsql-document-store.ts'
import { createWorkspaceTail } from '../../src/server/store/workspace-tail.ts'
import { measureLoopAvailability } from '../../src/shared/test-utils/loop-availability.ts'

const DOCUMENTS_PER_WORKSPACE = 20
const NODES_PER_DOCUMENT = 50
const COUNTS = [1, 10, 50]
const PASSES = 20

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function content(prefix) {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: Array.from({ length: NODES_PER_DOCUMENT }, (_unused, i) =>
      fileNode({
        id: `node-${i}`,
        file: newImageRef(`${prefix}-${i}`),
        x: i,
        y: i,
        width: 100,
        height: 100,
      }),
    ),
    edges: [],
  })
  doc.commit()
  return doc
}

/** A workspace record of realistic size: every document's content lives in the one tree. */
async function seed(docs, workspaceId) {
  const workspace = new LoroDoc()
  for (let d = 0; d < DOCUMENTS_PER_WORKSPACE; d += 1) {
    const documentId = generateDocumentId()
    createWorkspaceDocumentAtPath(workspace, { path: `doc-${d}`, documentId, kind: 'spatial' })
    writeWorkspaceDocumentContent(workspace, documentId, content(`${workspaceId}-${d}`))
  }
  workspace.commit()
  await docs.save(workspaceId, workspace)
  return workspace
}

async function remoteEdit(docs, workspaceId, round) {
  const stored = await docs.open(workspaceId)
  stored.getMap('meta').set(`remote-${round}`, round)
  stored.commit()
  await docs.save(workspaceId, stored)
}

async function timed(run) {
  const samples = []
  for (let i = 0; i < 2000; i += 1) {
    const start = performance.now()
    await run()
    samples.push(performance.now() - start)
  }
  return { median: median(samples), p99: percentile(samples, 0.99) }
}

/** Idle passes, then passes after a remote edit in every subscribed workspace. */
async function measurePasses(docs, count) {
  const live = new Map()
  const subscribed = []
  for (let i = 0; i < count; i += 1) {
    const id = `ws-${count}-${i}`
    live.set(id, await seed(docs, id))
    subscribed.push(id)
  }
  let emitted = 0
  const tail = createWorkspaceTail({
    subscribedWorkspaces: () => subscribed,
    docs,
    liveDoc: async (id) => live.get(id),
    emit: () => {
      emitted += 1
    },
    intervalMs: 1000,
  })
  await tail.pollOnce()
  const run = async (edit) => {
    const elapsed = []
    const worst = []
    for (let round = 0; round < PASSES; round += 1) {
      if (edit) for (const id of subscribed) await remoteEdit(docs, id, round)
      const { availability } = await measureLoopAvailability(() => tail.pollOnce(), {
        intervalMs: 1,
      })
      elapsed.push(availability.elapsedMs)
      worst.push(availability.worstStallMs)
    }
    return { elapsed: median(elapsed), worst: median(worst) }
  }
  const idle = await run(false)
  const emittedWhenIdle = emitted
  const gain = await run(true)
  return { idle, gain, emittedWhenIdle, emittedWithEdits: emitted - emittedWhenIdle }
}

const root = await mkdtemp(join(tmpdir(), 'wb-follow-cost-'))
const handle = await createIsolatedDb({ dataDir: join(root, 'data'), memory: false })
try {
  const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(handle.db))
  const held = await seed(docs, 'stamp-ws')
  const store = new LibsqlDocumentStore(handle.db)
  let stampOrder
  const stamp = await timed(async () => {
    const stored = await store.readFrontier({
      docRef: { kind: 'workspace-tree', workspaceId: 'stamp-ws' },
    })
    stampOrder = held.oplogVersion().compare(VersionVector.decode(stored.frontier))
  })
  const cursor = await timed(() => docs.readCursor('stamp-ws'))
  // The floor: a statement that reads nothing, so the stamp's price can be
  // told apart from what any query through this client costs.
  const floor = await timed(() => sql`select 1`.execute(handle.rawDb))
  for (const [label, result] of [
    ['stamp (readFrontier + compare)', stamp],
    ['cursor (readCursor)', cursor],
    ['floor (select 1)', floor],
  ]) {
    console.log(
      `${label.padEnd(32)} median ${result.median.toFixed(3)}ms, p99 ${result.p99.toFixed(3)}ms`,
    )
  }

  // The copy this process holds is level with what it just saved: 0, not stale.
  let failed = stampOrder !== 0
  for (const count of COUNTS) {
    const { idle, gain, emittedWhenIdle, emittedWithEdits } = await measurePasses(docs, count)
    console.log(
      `N=${count}: idle pass median ${idle.elapsed.toFixed(2)}ms (worst stall ${idle.worst.toFixed(2)}ms), ` +
        `with a remote edit in each ${gain.elapsed.toFixed(2)}ms (worst stall ${gain.worst.toFixed(2)}ms)`,
    )
    if (emittedWhenIdle !== 0 || emittedWithEdits === 0) failed = true
  }
  if (failed) {
    console.error(
      'preflight failed: the stamp read a level copy as stale, an idle pass emitted, or a pass with a remote edit did not',
    )
    process.exitCode = 1
  }
} finally {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
}
