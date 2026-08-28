/**
 * Promotion, slice 1: a browser-kept workspace record transfers INTO a daemon
 * workspace through the EXISTING workspace-document/update route, with the
 * documents' identity intact — same documentId, kind, name and body on the
 * other side, path collisions surfacing as shadowed pairs rather than
 * renames, and a post-transfer edit arriving as an ordinary incremental
 * delta (the replica plane).
 *
 * No production route is added: the route's `doc.import(bytes)` IS the
 * identity- and history-preserving CRDT merge. This file is the acceptance
 * bar later slices build on; if a route or bridge change breaks any leg of
 * it, promotion silently degrades into the per-document copy it replaces.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
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
const { clearCache } = await import('../../store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('../../store/document-store.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'promote-ws-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const SKETCH_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const CONTESTED_ID = '01BRWAAAAAAAAAAAAAAAAAAAA2'

function browserRecord(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
    name: 'Roadmap',
  })
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# roadmap v1')
  createWorkspaceDocumentAtPath(doc, {
    path: 'sketch',
    documentId: SKETCH_ID,
    kind: 'spatial',
  })
  // The same path the daemon workspace already holds — merged, not renamed.
  createWorkspaceDocumentAtPath(doc, {
    path: 'contested',
    documentId: CONTESTED_ID,
    kind: 'markdown',
  })
  doc.commit()
  return doc
}

async function listDocuments(app: ReturnType<typeof createDocumentRouter>) {
  const res = await app.request('/api/workspaces/session1/documents')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    documents: Array<{
      path: string
      id: string
      kind: string
      displayName?: string
      shadowed?: boolean
    }>
  }
  return body.documents
}

it('a browser record promotes through workspace-document/update: ids, kinds, names and bodies survive; collisions shadow', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  // The daemon workspace pre-exists with its own document at the contested
  // path — the workspaceId maps by TARGETING an existing workspace, never by
  // the browser's fixed 'local' id leaking through.
  const created = await app.request('/api/workspaces/session1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'contested' }),
  })
  expect(created.status).toBe(200)

  const browser = browserRecord()
  const res = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(browser.export({ mode: 'snapshot' })),
  })
  expect(res.status).toBe(200)

  const documents = await listDocuments(app)
  // Presence first: exactly the merged surface — 3 browser documents plus
  // the daemon's own, no duplicates — before any per-row claim.
  expect(documents).toHaveLength(4)
  const byId = new Map(documents.map((d) => [d.id, d]))
  expect(byId.get(ROADMAP_ID)?.path).toBe('notes/roadmap')
  expect(byId.get(ROADMAP_ID)?.kind).toBe('markdown')
  // The workspace-kept display name crossed with the identity (the list
  // publishes it as `displayName`).
  expect(byId.get(ROADMAP_ID)?.displayName).toBe('Roadmap')
  expect(byId.get(SKETCH_ID)?.kind).toBe('spatial')
  // The collision keeps BOTH documents at the path; exactly one row wins the
  // address and the other carries the shadowed marker.
  const contested = documents.filter((d) => d.path === 'contested')
  expect(contested).toHaveLength(2)
  expect(contested.filter((d) => d.shadowed === true)).toHaveLength(1)
  expect(contested.map((d) => d.id)).toContain(CONTESTED_ID)

  // Content and name crossed with the identity.
  const snapshotRes = await app.request('/api/w/session1/workspace-document/snapshot')
  expect(snapshotRes.status).toBe(200)
  const daemonView = new LoroDoc()
  daemonView.import(new Uint8Array(await snapshotRes.arrayBuffer()))
  expect(readMarkdownBody(documentContainers(daemonView, ROADMAP_ID))).toBe('# roadmap v1')
})

it('workspace-document/update answers 404 for a workspace the daemon never registered', async () => {
  // Promotion cannot mint a workspace as a side effect — the browser's fixed
  // 'local' id must never leak through as a new daemon workspace.
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const res = await app.request('/api/w/unregistered/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(browserRecord().export({ mode: 'snapshot' })),
  })
  expect(res.status).toBe(404)
})

it('an edit made after the promotion export still lands as an incremental delta — the replica plane', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  // Promotion targets an EXISTING workspace — the update route answers 404
  // for one the daemon never registered, so the flow registers first. Here
  // that registration rides an ordinary document create.
  const created = await app.request('/api/workspaces/session1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'daemon-own' }),
  })
  expect(created.status).toBe(200)
  const browser = browserRecord()
  const promote = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(browser.export({ mode: 'snapshot' })),
  })
  expect(promote.status).toBe(200)

  // The browser keeps writing offline; on reconnect only the delta travels.
  const from = browser.version()
  writeMarkdownBody(documentContainers(browser, ROADMAP_ID), '# roadmap v2 — offline edit')
  browser.commit()
  const delta = new Uint8Array(browser.export({ mode: 'update', from }))
  // A delta, not a re-snapshot: measured at 156 bytes for a one-line edit
  // against a 272 KB record. The size bound is what makes replica-mode sync
  // viable per keystroke; a re-snapshot here would be a design regression.
  expect(delta.byteLength).toBeLessThan(4096)

  const res = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: delta,
  })
  expect(res.status).toBe(200)

  const snapshotRes = await app.request('/api/w/session1/workspace-document/snapshot')
  const daemonView = new LoroDoc()
  daemonView.import(new Uint8Array(await snapshotRes.arrayBuffer()))
  expect(readMarkdownBody(documentContainers(daemonView, ROADMAP_ID))).toBe(
    '# roadmap v2 — offline edit',
  )
})
