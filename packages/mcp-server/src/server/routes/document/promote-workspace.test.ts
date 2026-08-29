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
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
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
const { clearCache } = await import('../../store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests, onWorkspaceDocUpdated } = await import(
  '../../store/document-store.js'
)
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'promote-ws-'))
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

// --- Slice 2: targeting, idempotency, and the live-session blast radius ---

async function daemonSnapshot(app: ReturnType<typeof createDocumentRouter>): Promise<LoroDoc> {
  const res = await app.request('/api/w/session1/workspace-document/snapshot')
  expect(res.status).toBe(200)
  const doc = new LoroDoc()
  doc.import(new Uint8Array(await res.arrayBuffer()))
  return doc
}

it('promotion lands as ONE fan-out frame under a live subscriber, whose pending edit then merges instead of being overwritten', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const created = await app.request('/api/workspaces/session1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'daemon-own' }),
  })
  expect(created.status).toBe(200)

  // A live daemon-mode session: its own replica of the workspace record,
  // with an UNCOMMITTED local edit pending when the promotion arrives.
  const replica = await daemonSnapshot(app)
  const preMerge = replica.export({ mode: 'snapshot' })
  const preEditVersion = replica.version()
  const own = resolveWorkspaceDocument(replica, 'daemon-own')
  expect(own).not.toBeNull()
  if (own === null) return
  writeSpatialCanvas(documentContainers(replica, own.documentId), {
    nodes: [{ id: 'live-edit', type: 'text', text: 'live', x: 0, y: 0, width: 10, height: 10 }],
    edges: [],
  })
  replica.commit()
  const pendingDelta = new Uint8Array(replica.export({ mode: 'update', from: preEditVersion }))

  const frames: Uint8Array[] = []
  const unsubscribe = onWorkspaceDocUpdated((workspaceId, update) => {
    if (workspaceId === 'session1') frames.push(update)
  })
  try {
    const res = await app.request('/api/w/session1/workspace-document/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(browserRecord().export({ mode: 'snapshot' })),
    })
    expect(res.status).toBe(200)
  } finally {
    unsubscribe()
  }

  // One import, one frame — the fan-out runs after the write settles, never
  // as interleaved partial writes mid-import.
  expect(frames).toHaveLength(1)
  // The frame is well-formed and carries the WHOLE merge: importing it onto
  // a pre-merge copy resolves the promoted documents.
  const observer = new LoroDoc()
  observer.import(new Uint8Array(preMerge))
  observer.import(frames[0] as Uint8Array)
  expect(readMarkdownBody(documentContainers(observer, ROADMAP_ID))).toBe('# roadmap v1')

  // The pending local edit now lands — a commutative merge, not a clobber:
  // the daemon ends up holding BOTH the promoted content and the live edit.
  const pushed = await app.request('/api/w/session1/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pendingDelta,
  })
  expect(pushed.status).toBe(200)
  const final = await daemonSnapshot(app)
  expect(readMarkdownBody(documentContainers(final, ROADMAP_ID))).toBe('# roadmap v1')
  const canvas = readSpatialCanvas(documentContainers(final, own.documentId))
  expect(canvas.nodes.map((n) => n.id)).toEqual(['live-edit'])
})

it('promoting the same snapshot twice is idempotent — no duplicate documents, no error', async () => {
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const created = await app.request('/api/workspaces/session1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'daemon-own' }),
  })
  expect(created.status).toBe(200)

  // The retry case: a promotion whose response was lost re-sends the SAME
  // snapshot. Loro import of already-known ops is a no-op, so the second
  // POST must neither fail nor duplicate anything.
  const snapshot = new Uint8Array(browserRecord().export({ mode: 'snapshot' }))
  for (const _round of [1, 2]) {
    const res = await app.request('/api/w/session1/workspace-document/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: snapshot,
    })
    expect(res.status).toBe(200)
  }

  const documents = await listDocuments(app)
  expect(documents).toHaveLength(4)
  expect(new Set(documents.map((d) => d.id)).size).toBe(4)
})

it("the literal workspace id 'local' cannot be minted by a promotion", async () => {
  // 'local' is the browser keeper's FIXED stored id (vocabulary.md's keeper
  // axis). A promotion that let it through would resurrect the retired
  // browser-local sense as a daemon workspace. The route already refuses
  // every unregistered id; this pins that 'local' gets no special pass.
  const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
  const res = await app.request('/api/w/local/workspace-document/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(browserRecord().export({ mode: 'snapshot' })),
  })
  expect(res.status).toBe(404)
})
