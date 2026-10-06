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
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  seedWorkspaceRow,
  testDocumentRouterOptions,
} from '../_test-helpers.js'

let tempDir: string
// The deps a router is handed by its root; here, the test wiring over the
// isolated data dir.
let serverDeps: ServerDeps
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { listDocuments, loadDocument, onWorkspaceDocUpdated, _clearWorkspaceDocCacheForTests } =
  await import('../../store/document-store.js')
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-route-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  // The workspace exists because this fixture says so, not because the first
  // POST created it: that route passes `createWorkspace: true`, which is
  // ADR-0019's MINT boundary — a mint keys the workspace by a fresh ULID and
  // files `session1` as its segment, leaving the direct store reads in these
  // cases naming nothing.
  await seedWorkspaceRow(tempDir, 'session1')
  serverDeps = await resolveTestServerDeps(tempDir)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasUpdate(doc: LoroDoc, ids: string[]): Uint8Array<ArrayBuffer> {
  const from = doc.version()
  writeSpatialCanvas(doc, {
    nodes: ids.map((id) => textNode({ id, text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return new Uint8Array(doc.export({ mode: 'update', from }))
}

async function createDoc(path: string) {
  await createTestDocument(serverDeps, { workspaceId: 'session1', path })
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
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
    }),
  )
  await createDoc('c')
  await pushDoc(app, new LoroDoc(), ['n-a'])

  const peer = await fetchWorkspaceSnapshot(app)
  const entry = resolveWorkspaceDocument(peer, 'c')
  expect(entry).not.toBeNull()
  if (entry === null) return
  const canvas = readSpatialCanvas(documentContainers(peer, entry.documentId))
  expect(canvas.nodes.map((n) => n.id)).toEqual(['n-a'])
})

it('GET workspace-document/snapshot refuses an unregistered workspace', async () => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
    }),
  )
  const res = await app.request('/api/w/never-registered/workspace-document/snapshot')
  expect(res.status).toBe(404)
})

it('POST workspace-document/update lands on the tree and refreshes per-document reads', async () => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
    }),
  )
  await createDoc('c')
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
      textNode({ id: 'n-a', text: 'n-a', x: 0, y: 0, width: 10, height: 10 }),
      textNode({ id: 'n-b', text: 'n-b', x: 0, y: 0, width: 10, height: 10 }),
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
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
    }),
  )
  await createDoc('c')
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
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
    }),
  )
  await createDoc('c')
  const res = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array([1, 2, 3, 4]),
  })
  expect(res.status).toBe(400)
})

/**
 * What the page's editor sends: one workspace update carrying the edits it
 * made, with nothing in the URL saying which documents they were.
 */
async function editorUpdate(
  app: ReturnType<typeof createDocumentRouter>,
  edits: Readonly<Record<string, string>>,
): Promise<void> {
  const peer = await fetchWorkspaceSnapshot(app)
  const from = peer.version()
  for (const [path, nodeId] of Object.entries(edits)) {
    const entry = resolveWorkspaceDocument(peer, path)
    if (entry === null) throw new Error(`no document at ${path}`)
    writeSpatialCanvas(documentContainers(peer, entry.documentId), {
      nodes: [textNode({ id: nodeId, text: nodeId, x: 0, y: 0, width: 10, height: 10 })],
      edges: [],
    })
  }
  peer.commit()
  const res = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(peer.export({ mode: 'update', from })),
  })
  expect(res.status).toBe(200)
}

async function autoVersionsOf(app: ReturnType<typeof createDocumentRouter>, path: string) {
  const res = await app.request(`/api/workspaces/session1/documents/${path}/versions`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { versions: { auto?: boolean }[] }
  return body.versions.filter((version) => version.auto === true).length
}

async function listedUpdatedAt(app: ReturnType<typeof createDocumentRouter>, path: string) {
  const res = await app.request('/api/workspaces/session1/documents')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { documents: { path: string; updatedAt?: string }[] }
  return {
    route: body.documents.find((document) => document.path === path)?.updatedAt,
    store: (await listDocuments('session1')).find((document) => document.path === path)?.updatedAt,
  }
}

/** Until the clock has moved past `iso`, so a stamp taken now cannot equal it. */
async function clockPast(iso: string | undefined): Promise<void> {
  const at = Date.parse(iso ?? '')
  expect(at).not.toBeNaN()
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(at))
}

it('an editor update checkpoints the document it edited once it goes quiet', async () => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 30 }),
  )
  await createDoc('a')

  await editorUpdate(app, { a: 'n-a' })

  await expect.poll(() => autoVersionsOf(app, 'a'), { timeout: 5_000 }).toBe(1)
})

it('an editor update touching two documents checkpoints both, and no other', async () => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 30 }),
  )
  await createDoc('a')
  await createDoc('b')
  await createDoc('untouched')

  await editorUpdate(app, { a: 'n-a', b: 'n-b' })

  await expect.poll(() => autoVersionsOf(app, 'a'), { timeout: 5_000 }).toBe(1)
  await expect.poll(() => autoVersionsOf(app, 'b'), { timeout: 5_000 }).toBe(1)
  expect(await autoVersionsOf(app, 'untouched')).toBe(0)
})

it('an editor update moves the edited document’s listed updatedAt, and no other', async () => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
  )
  await createDoc('a')
  await createDoc('untouched')
  const before = await listedUpdatedAt(app, 'a')
  const untouched = await listedUpdatedAt(app, 'untouched')
  expect(before.route).toBe(before.store)
  await clockPast(before.store)
  await clockPast(untouched.store)

  await editorUpdate(app, { a: 'n-a' })

  const after = await listedUpdatedAt(app, 'a')
  expect(Date.parse(after.store ?? '')).toBeGreaterThan(Date.parse(before.store ?? ''))
  expect(after.route).toBe(after.store)
  expect(await listedUpdatedAt(app, 'untouched')).toEqual(untouched)
})
