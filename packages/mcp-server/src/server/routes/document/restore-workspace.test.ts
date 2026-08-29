/**
 * Versions and restore over the workspace document:
 *
 * - a version of a tree-served document survives a daemon restart (the
 *   checkpoint lives in the workspace document's durable oplog, not in a
 *   projection's per-process lineage), and
 * - an in-place restore actually makes the content equal the past state.
 *   The old mechanism (`doc.import(past.export())`) was a measured no-op:
 *   restoring v1 left a later-added node in place. This file is the
 *   regression pin for both.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seedWorkspaceRow } from '../_test-helpers.js'

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
const { loadDocument, listDocuments, _clearWorkspaceDocCacheForTests } = await import(
  '../../store/document-store.js'
)
const { clearCache } = await import('../../store/doc-cache.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'restore-ws-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
  _clearWorkspaceDocCacheForTests()
  // The workspace exists because this fixture says so, not because the first
  // POST created it: that route passes `createWorkspace: true`, which is
  // ADR-0019's MINT boundary — a mint keys the workspace by a fresh ULID and
  // files `session1` as its segment, leaving the direct store reads in these
  // cases naming nothing.
  await seedWorkspaceRow(tempDir, 'session1')
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

async function push(app: ReturnType<typeof createDocumentRouter>, doc: LoroDoc, ids: string[]) {
  await app.request('/api/w/session1/document/c/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: canvasUpdate(doc, ids),
  })
}

async function saveVersion(app: ReturnType<typeof createDocumentRouter>): Promise<string> {
  const res = await app.request('/api/workspaces/session1/documents/c/versions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'v1' }),
  })
  const { version } = (await res.json()) as { version: { id: string } }
  return version.id
}

it('in-place restore makes the document equal the past state — a later-added node goes away', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const client = new LoroDoc()
  await push(app, client, ['n-a'])
  const versionId = await saveVersion(app)
  await push(app, client, ['n-a', 'n-b'])

  const res = await app.request(
    `/api/workspaces/session1/documents/c/versions/${versionId}/restore`,
    { method: 'POST' },
  )
  expect(res.status).toBe(200)

  const after = await loadDocument('session1', 'c')
  expect(readSpatialCanvas(after).nodes.map((n) => n.id)).toEqual(['n-a'])
})

it('a version of a tree-served document restores correctly after a simulated restart', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const client = new LoroDoc()
  await push(app, client, ['n-a'])
  const versionId = await saveVersion(app)
  await push(app, client, ['n-a', 'n-b'])

  // Restart: every in-memory doc — the per-document projections AND the
  // live workspace documents — is gone; only stored bytes remain.
  clearCache()
  _clearWorkspaceDocCacheForTests()

  const res = await app.request(
    `/api/workspaces/session1/documents/c/versions/${versionId}/restore`,
    { method: 'POST' },
  )
  expect(res.status).toBe(200)

  const after = await loadDocument('session1', 'c')
  expect(readSpatialCanvas(after).nodes.map((n) => n.id)).toEqual(['n-a'])
})

async function createDoc(app: ReturnType<typeof createDocumentRouter>, path: string) {
  await app.request('/api/workspaces/session1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

it('subtree rollback reverts the document AND its descendants, and evacuates documents created after the version', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const parent = new LoroDoc()
  const child = new LoroDoc()
  // Created through the create route, so the rows carry a kind and the
  // documents live on the workspace tree — the plane whose versions are
  // workspace-scoped.
  await createDoc(app, 'c')
  await createDoc(app, 'c/child')
  await push(app, parent, ['p-1'])
  await app.request('/api/w/session1/document/c%2Fchild/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: canvasUpdate(child, ['c-1']),
  })
  const versionId = await saveVersion(app)

  // After the version: parent and child both edited, and a NEW descendant
  // appears.
  await push(app, parent, ['p-1', 'p-2'])
  await app.request('/api/w/session1/document/c%2Fchild/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: canvasUpdate(child, ['c-1', 'c-2']),
  })
  const late = new LoroDoc()
  await createDoc(app, 'c/late')
  await app.request('/api/w/session1/document/c%2Flate/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: canvasUpdate(late, ['x-1']),
  })

  const res = await app.request(
    `/api/workspaces/session1/documents/c/versions/${versionId}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtree: true }),
    },
  )
  expect(res.status).toBe(200)

  expect(readSpatialCanvas(await loadDocument('session1', 'c')).nodes.map((n) => n.id)).toEqual([
    'p-1',
  ])
  expect(
    readSpatialCanvas(await loadDocument('session1', 'c/child')).nodes.map((n) => n.id),
  ).toEqual(['c-1'])
  // The late-born descendant is gone from the listing (evacuated, not
  // destroyed — the tree delete goes through the trash).
  const paths = (await listDocuments('session1')).map((row) => row.path)
  expect(paths).not.toContain('c/late')
  expect(paths.sort()).toEqual(['c', 'c/child'])
})
