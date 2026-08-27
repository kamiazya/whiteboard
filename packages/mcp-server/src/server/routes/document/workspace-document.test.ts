/**
 * The workspace-granularity sync surface: one snapshot/update pair for the
 * WHOLE workspace document, instead of one per document path.
 *
 * Two properties carry the design:
 * - every mutation path funnels through `saveWorkspaceDoc`, so a single
 *   subscription sees per-document edits too, and
 * - a workspace-granularity import invalidates every cached per-document
 *   projection — without that, the next per-document save would diff STALE
 *   content back over the imported edit and silently revert it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  documentContainers,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { loadDocument, onWorkspaceDocUpdated, _clearWorkspaceDocCacheForTests } = await import(
  '../../store/document-store.js'
)
const { clearCache } = await import('../../store/doc-cache.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-route-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasUpdate(doc: LoroDoc, ids: string[]): Uint8Array {
  const from = doc.version()
  writeSpatialCanvas(doc, {
    nodes: ids.map((id) => ({ id, type: 'text', text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return new Uint8Array(doc.export({ mode: 'update', from }))
}

async function createDoc(app: ReturnType<typeof createDocumentRouter>, path: string) {
  const res = await app.request('/api/workspaces/session1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  expect(res.status).toBe(200)
}

async function pushDoc(app: ReturnType<typeof createDocumentRouter>, doc: LoroDoc, ids: string[]) {
  const res = await app.request('/api/w/session1/document/c/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: canvasUpdate(doc, ids),
  })
  expect(res.status).toBe(200)
}

async function fetchWorkspaceSnapshot(
  app: ReturnType<typeof createDocumentRouter>,
): Promise<LoroDoc> {
  const res = await app.request('/api/w/session1/workspace-document/snapshot')
  expect(res.status).toBe(200)
  const doc = new LoroDoc()
  doc.import(new Uint8Array(await res.arrayBuffer()))
  return doc
}

it('GET workspace-document/snapshot answers a document a peer can resolve paths in', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  await createDoc(app, 'c')
  await pushDoc(app, new LoroDoc(), ['n-a'])

  const peer = await fetchWorkspaceSnapshot(app)
  const entry = resolveWorkspaceDocument(peer, 'c')
  expect(entry).not.toBeNull()
  if (entry === null) return
  const canvas = readSpatialCanvas(documentContainers(peer, entry.documentId))
  expect(canvas.nodes.map((n) => n.id)).toEqual(['n-a'])
})

it('GET workspace-document/snapshot refuses an unregistered workspace', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const res = await app.request('/api/w/never-registered/workspace-document/snapshot')
  expect(res.status).toBe(404)
})

it('POST workspace-document/update lands on the tree and refreshes per-document reads', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  await createDoc(app, 'c')
  await pushDoc(app, new LoroDoc(), ['n-a'])
  // Warm the per-document projection cache so the test proves invalidation,
  // not just a cold read.
  expect(readSpatialCanvas(await loadDocument('session1', 'c')).nodes.map((n) => n.id)).toEqual([
    'n-a',
  ])

  const peer = await fetchWorkspaceSnapshot(app)
  const entry = resolveWorkspaceDocument(peer, 'c')
  expect(entry).not.toBeNull()
  if (entry === null) return
  const from = peer.version()
  writeSpatialCanvas(documentContainers(peer, entry.documentId), {
    nodes: [
      { id: 'n-a', type: 'text', text: 'n-a', x: 0, y: 0, width: 10, height: 10 },
      { id: 'n-b', type: 'text', text: 'n-b', x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [],
  })
  peer.commit()

  const res = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(peer.export({ mode: 'update', from })),
  })
  expect(res.status).toBe(200)

  expect(readSpatialCanvas(await loadDocument('session1', 'c')).nodes.map((n) => n.id)).toEqual([
    'n-a',
    'n-b',
  ])
})

it('a PER-DOCUMENT update reaches a workspace-document subscriber', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  await createDoc(app, 'c')
  await pushDoc(app, new LoroDoc(), ['n-a'])

  const replica = await fetchWorkspaceSnapshot(app)
  const updates: Uint8Array[] = []
  const unsubscribe = onWorkspaceDocUpdated((workspaceId, update) => {
    if (workspaceId === 'session1') updates.push(update)
  })
  try {
    const client = new LoroDoc()
    client.import(
      new Uint8Array(
        await (await app.request('/api/w/session1/document/c/snapshot')).arrayBuffer(),
      ),
    )
    await pushDoc(app, client, ['n-a', 'n-b'])
  } finally {
    unsubscribe()
  }

  expect(updates.length).toBeGreaterThan(0)
  for (const update of updates) replica.import(update)
  const entry = resolveWorkspaceDocument(replica, 'c')
  expect(entry).not.toBeNull()
  if (entry === null) return
  const canvas = readSpatialCanvas(documentContainers(replica, entry.documentId))
  expect(canvas.nodes.map((n) => n.id)).toEqual(['n-a', 'n-b'])
})

it('a malformed workspace-document update is a 400, not a daemon crash', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  await createDoc(app, 'c')
  const res = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array([1, 2, 3, 4]),
  })
  expect(res.status).toBe(400)
})
