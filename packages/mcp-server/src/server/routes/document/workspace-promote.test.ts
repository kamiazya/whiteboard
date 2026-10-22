/**
 * The promote route: the same merge as workspace-document/update, plus one
 * explicit human checkpoint per promoted document. No keeper holds a passkey
 * pin (ADR-0050 decision 3), so an attestation sent beside the bytes names a
 * credential nothing here can check, and is refused before anything lands.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROMOTE_MAX_TRASH,
  PROMOTE_MAX_VERSIONS,
  promoteWorkspaceResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  MAX_AUTO_PER_DOCUMENT,
  MAX_MANUAL_PER_DOCUMENT,
  MAX_RESTORE_POINTS_PER_DOCUMENT,
} from '@kamiazya/whiteboard-history'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  readMarkdownBody,
  readSpatialCanvas,
  recordTrashEntry,
  resolveWorkspaceDocumentById,
  WORKSPACE_TREE_KEY,
  writeMarkdownBody,
  writeSpatialCanvas,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  CANVAS_MAX_NODES,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { WORKSPACE_MAX_DOCUMENTS } from '@kamiazya/whiteboard-ports'
import { apiErrorBodySchema, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import type * as versionEntry from '@kamiazya/whiteboard-server-core/versions/version-entry'
import { PROMOTE_MAX_JUDGED_ELEMENTS } from '@kamiazya/whiteboard-server-core/versions/version-entry'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  seedWorkspaceRow,
  testDocumentRouterOptions,
} from '../_test-helpers.js'

let tempDir: string
// The deps a router is handed by its root; here, the test wiring over the
// isolated data dir.
let serverDeps: ServerDeps
// The judgement budget is reached in a test by lowering it, not by projecting
// a hundred million characters.
let judgedBudget: number | undefined
vi.mock('@kamiazya/whiteboard-server-core/versions/version-entry', async (importOriginal) => {
  const real = await importOriginal<typeof versionEntry>()
  return {
    ...real,
    get PROMOTE_MAX_JUDGED_ELEMENTS() {
      return judgedBudget ?? real.PROMOTE_MAX_JUDGED_ELEMENTS
    },
  }
})
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('../../store/document-store.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')
const { FileVersionStore } = await import('../../store/version-store.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'promote-route-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await seedWorkspaceRow(tempDir, 'session1')
  serverDeps = await resolveTestServerDeps(tempDir)
})
afterEach(async () => {
  judgedBudget = undefined
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const SKETCH_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

function browserSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
    name: 'Roadmap',
  })
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SKETCH_ID, kind: 'spatial' })
  doc.commit()
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

function harness() {
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
    }),
  )
  const promote = (body: unknown) =>
    app.request('/api/w/session1/workspace-document/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const documents = async () => {
    const res = await app.request('/api/workspaces/session1/documents')
    expect(res.status).toBe(200)
    return ((await res.json()) as { documents: { id: string }[] }).documents
  }
  return { app, promote, documents }
}

it('merges the record and leaves one explicit human checkpoint per document', async () => {
  const { promote, documents } = harness()
  const snapshot = browserSnapshot()
  const res = await promote({ snapshot: b64u(snapshot) })
  expect(res.status).toBe(200)
  promoteWorkspaceResponseSchema.parse(await res.json())
  expect(await documents()).toHaveLength(2)
  const versions = await new FileVersionStore().list('session1', 'sketch')
  expect(versions).toHaveLength(1)
  expect(versions[0]?.auto).toBe(false)
  expect(versions[0]?.operator?.kind).toBe('human')
  expect(versions[0]?.attestation).toBeUndefined()
})

it("names the calling member on the promote checkpoint, not the server's OS account", async () => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
      callerName: async () => 'Ada',
    }),
  )
  const res = await app.request('/api/w/session1/workspace-document/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot: b64u(browserSnapshot()) }),
  })
  expect(res.status).toBe(200)
  const versions = await new FileVersionStore().list('session1', 'sketch')
  expect(versions[0]?.operator).toEqual({ kind: 'human', displayName: 'Ada' })
})

it('refuses an attestation as a body outside the contract, since no passkey is pinned here, and merges nothing', async () => {
  const { promote, documents } = harness()
  const snapshot = browserSnapshot()
  const res = await promote({
    snapshot: b64u(snapshot),
    attestation: {
      kind: 'webauthn',
      credentialId: 'Y3JlZA',
      authenticatorData: 'YXV0aA',
      clientDataJSON: 'Y2xpZW50',
      signature: 'c2ln',
    },
  })
  expect(res.status).toBe(400)
  expect(((await res.json()) as { error: string }).error).toBe('invalid_body')
  expect(await documents()).toEqual([])
  expect(await new FileVersionStore().list('session1', 'sketch')).toEqual([])
})

it('refuses a body that is not the contract, and bytes that are not a record', async () => {
  const { promote } = harness()
  expect((await promote({ snapshot: 'not base64url!' })).status).toBe(400)
  expect((await promote({ snapshot: b64u(browserSnapshot()), extra: 1 })).status).toBe(400)
  const notLoro = await promote({ snapshot: b64u(new Uint8Array([1, 2, 3, 4])) })
  expect(notLoro.status).toBe(400)
  expect(await new FileVersionStore().list('session1', 'sketch')).toEqual([])
})

it('answers bytes that are not a record in the code family, under a code of their own', async () => {
  const { promote } = harness()
  const res = await promote({ snapshot: b64u(new Uint8Array([1, 2, 3, 4])) })
  expect(res.status).toBe(400)
  // Not `invalid_body`: a sender reads that code, beside carried planes, as an
  // older daemon refusing the planes, and this refusal is of the record.
  expect(await res.json()).toEqual({
    error: 'malformed_snapshot',
    message: 'Malformed workspace record snapshot',
  })
})

// The cap as the route's caller reads it (ADR-0044's desktop browser-keeper
// limit), stated here rather than imported so the test judges the operation.
const PROMOTE_DOCUMENT_CAP = 2000

it('refuses a record past the document cap with 413 under its own code, and keeps none of it', async () => {
  const { promote, documents } = harness()
  // Raw tree nodes in one commit: the path-checked create walks the whole
  // tree per call, which makes a fixture this size take minutes.
  const record = new LoroDoc()
  const tree = record.getTree(WORKSPACE_TREE_KEY)
  const ulid = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  for (let i = 0; i <= PROMOTE_DOCUMENT_CAP; i++) {
    const node = tree.createNode()
    const suffix = `${ulid[Math.floor(i / 1024) % 32]}${ulid[Math.floor(i / 32) % 32]}${ulid[i % 32]}`
    node.data.set('documentId', `01BRWC${suffix.padStart(20, '0')}`)
    node.data.set('segment', `d${i}`)
    node.data.set('kind', 'markdown')
    node.data.set('createdAt', 1_000)
    node.data.set('updatedAt', 1_000)
  }
  record.commit()

  const res = await promote({ snapshot: b64u(new Uint8Array(record.export({ mode: 'snapshot' }))) })
  expect(res.status).toBe(413)
  const body = (await res.json()) as { error: string; message: string }
  expect(body.error).toBe('promote_too_many_documents')
  expect(body.message).toContain(String(PROMOTE_DOCUMENT_CAP))
  expect(await documents()).toHaveLength(0)
  expect(await new FileVersionStore().list('session1', 'd0')).toHaveLength(0)
})

it('refuses more saved versions than one move carries with 413 under its own code, and keeps none of it', async () => {
  const { promote, documents } = harness()
  const row = { id: 'v', documentId: ROADMAP_ID, createdAt: 1, auto: true, frontiers: 'AA' }
  const res = await promote({
    snapshot: b64u(browserSnapshot()),
    versions: Array.from({ length: PROMOTE_MAX_VERSIONS + 1 }, () => row),
  })
  expect(res.status).toBe(413)
  const body = (await res.json()) as { error: string; message: string }
  // Not `invalid_body`, which a sender reads as an older keeper refusing the planes.
  expect(body.error).toBe('promote_too_many_carried')
  expect(body.message).toContain(`${PROMOTE_MAX_VERSIONS} saved versions`)
  expect(await documents()).toHaveLength(0)
})

it('refuses more trashed documents than one move carries with the same code', async () => {
  const { promote, documents } = harness()
  const res = await promote({
    snapshot: b64u(browserSnapshot()),
    trash: Array.from({ length: PROMOTE_MAX_TRASH + 1 }, () => ({
      documentId: SKETCH_ID,
      bytes: 'AA',
    })),
  })
  expect(res.status).toBe(413)
  expect(((await res.json()) as { error: string }).error).toBe('promote_too_many_carried')
  expect(await documents()).toHaveLength(0)
})

it('carries every automatic checkpoint a browser at the document ceiling can hold', () => {
  // server-core states the version cap without the history package it is
  // sized from; this is where both are in reach.
  expect(PROMOTE_MAX_VERSIONS).toBeGreaterThanOrEqual(
    MAX_AUTO_PER_DOCUMENT * WORKSPACE_MAX_DOCUMENTS,
  )
  expect(PROMOTE_MAX_TRASH).toBe(WORKSPACE_MAX_DOCUMENTS)
})

it('judges every version a browser can hold of one document at the largest body', () => {
  const perDocument =
    MAX_AUTO_PER_DOCUMENT + MAX_MANUAL_PER_DOCUMENT + MAX_RESTORE_POINTS_PER_DOCUMENT
  expect(PROMOTE_MAX_JUDGED_ELEMENTS).toBeGreaterThanOrEqual(perDocument * MARKDOWN_MAX_CHARS)
})

it('refuses saved versions that cost more to check than one move allows with 413, merging nothing', async () => {
  const { promote, documents } = harness()
  judgedBudget = 1
  const res = await promote(browserRecordWithTrashAndVersion())
  expect(res.status).toBe(413)
  const body = apiErrorBodySchema.parse(await res.json())
  expect(body).toMatchObject({ error: 'promote_too_many_carried' })
  expect('message' in body && body.message).toContain('at most 1 characters')
  expect(await documents()).toEqual([])
})

it('answers 404 for a workspace the daemon never registered', async () => {
  const { app } = harness()
  const res = await app.request('/api/w/unregistered/workspace-document/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot: b64u(browserSnapshot()) }),
  })
  expect(res.status).toBe(404)
})

it('refuses a record whose canvas holds a node past its bound, naming the canvas', async () => {
  const { promote, documents } = harness()
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SKETCH_ID, kind: 'spatial' })
  writeSpatialNode(
    documentContainers(doc, SKETCH_ID),
    textNode({
      id: 'big',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      text: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1),
    }),
  )
  doc.commit()
  const res = await promote({ snapshot: b64u(new Uint8Array(doc.export({ mode: 'snapshot' }))) })
  expect(res.status).toBe(413)
  const body = (await res.json()) as { error: string; message: string }
  expect(body.error).toBe('node_text_too_large')
  // The canvas a person can open, not only a node key they never see.
  expect(body.message).toMatch(/^The document at "sketch" /)
  expect(await documents()).toEqual([])
})

const GONE_ID = '01BRWAAAAAAAAAAAAAAAAAAAA2'
const DRAFTED_VERSION_ID = '01BRWVERSAAAAAAAAAAAAAAAA0'

/**
 * A browser record holding one live note with a labelled saved version taken
 * before its last edit, and one trashed note evacuated the way the browser
 * keeper deletes: the subtree exported, its sha-256 recorded on the entry.
 */
function browserRecordWithTrashAndVersion(
  trashed: { readonly path?: string; readonly body?: string } = {},
) {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# as drafted')
  doc.commit()
  const drafted = encodeFrontiers(doc.oplogFrontiers())
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# after the meeting')
  createWorkspaceDocumentAtPath(doc, { path: 'gone', documentId: GONE_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, GONE_ID), trashed.body ?? '# trashed in the browser')
  doc.commit()
  const evacuated = exportWorkspaceSubtree(doc, 'gone')
  if (evacuated === null) throw new Error('no subtree to evacuate')
  deleteWorkspaceNodeAtPath(doc, 'gone')
  recordTrashEntry(doc, {
    documentId: GONE_ID,
    path: trashed.path ?? 'gone',
    deletedAt: 1,
    blob: { algorithm: 'sha-256', digestHex: createHash('sha256').update(evacuated).digest('hex') },
  })
  doc.commit()
  return {
    snapshot: b64u(new Uint8Array(doc.export({ mode: 'snapshot' }))),
    trash: [{ documentId: GONE_ID, bytes: b64u(evacuated) }],
    versions: [
      {
        id: DRAFTED_VERSION_ID,
        documentId: ROADMAP_ID,
        createdAt: 1_000,
        auto: false,
        label: 'as drafted',
        frontiers: b64u(drafted),
      },
    ],
  }
}

it('carries a trashed document so the daemon restores it with its content', async () => {
  const { app, promote } = harness()
  const record = browserRecordWithTrashAndVersion()
  const res = await promote(record)
  expect(res.status).toBe(200)
  expect(promoteWorkspaceResponseSchema.parse(await res.json()).trashStored).toEqual([GONE_ID])

  const restored = await app.request(`/api/workspaces/session1/trash/${GONE_ID}/restore`, {
    method: 'POST',
  })
  expect(restored.status).toBe(200)
  const workspaceDoc = await serverDeps.workspaceDocuments.get('session1')
  expect(readMarkdownBody(documentContainers(workspaceDoc, GONE_ID))).toBe(
    '# trashed in the browser',
  )
})

// A carried trash row and its bytes are the other keeper's choice, and the
// trash map is not node meta, so nothing at promote time judges them: the
// restore does, as it would any sync write.
it.each([
  ['a path off the document grammar', { path: '../gone' }],
  ['a body past the length bound', { body: 'x'.repeat(MARKDOWN_MAX_CHARS + 1) }],
])('refuses to restore carried trash holding %s', async (_, trashed) => {
  const { app, promote } = harness()
  const res = await promote(browserRecordWithTrashAndVersion(trashed))
  expect(promoteWorkspaceResponseSchema.parse(await res.json()).trashStored).toEqual([GONE_ID])

  const restored = await app.request(`/api/workspaces/session1/trash/${GONE_ID}/restore`, {
    method: 'POST',
  })
  expect(restored.status).toBe(404)
  const workspaceDoc = await serverDeps.workspaceDocuments.get('session1')
  expect(resolveWorkspaceDocumentById(workspaceDoc, GONE_ID)).toBeNull()
})

// The daemon keeps ONE blob store per tenant, keyed by digest alone, so the
// same record moved into two workspaces leaves two trash rows naming one blob.
it.each([
  ['purged', 'DELETE', ''],
  ['restored', 'POST', '/restore'],
])("keeps another workspace's trashed copy restorable when it is %s in one", async (_, method, suffix) => {
  await seedWorkspaceRow(tempDir, 'session2')
  const { app } = harness()
  const record = browserRecordWithTrashAndVersion()
  for (const workspaceId of ['session1', 'session2']) {
    const res = await app.request(`/api/w/${workspaceId}/workspace-document/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
    expect(promoteWorkspaceResponseSchema.parse(await res.json()).trashStored).toEqual([GONE_ID])
  }

  const first = await app.request(`/api/workspaces/session1/trash/${GONE_ID}${suffix}`, { method })
  expect(first.status).toBe(200)

  const other = await app.request(`/api/workspaces/session2/trash/${GONE_ID}/restore`, {
    method: 'POST',
  })
  expect(other.status).toBe(200)
  const workspaceDoc = await serverDeps.workspaceDocuments.get('session2')
  expect(readMarkdownBody(documentContainers(workspaceDoc, GONE_ID))).toBe(
    '# trashed in the browser',
  )
})

it('refuses trash bytes that are not what the entry names, and merges nothing', async () => {
  const { promote, documents } = harness()
  const record = browserRecordWithTrashAndVersion()
  const res = await promote({
    ...record,
    trash: [{ documentId: GONE_ID, bytes: b64u(new Uint8Array([1, 2, 3])) }],
  })
  expect(res.status).toBe(400)
  // Its own code, not `invalid_body`: a sender reads that one, beside carried
  // planes, as a keeper too old to know the planes, and this daemon knows them.
  expect(((await res.json()) as { error: string }).error).toBe('unmatched_carried')
  expect(await documents()).toEqual([])
})

it('carries saved versions: listed for their document, label kept, restorable to their content', async () => {
  const { app, promote } = harness()
  const res = await promote(browserRecordWithTrashAndVersion())
  expect(res.status).toBe(200)
  expect(promoteWorkspaceResponseSchema.parse(await res.json()).versionsKept).toEqual([
    DRAFTED_VERSION_ID,
  ])

  const listed = await new FileVersionStore().list('session1', 'notes/roadmap')
  // The browser's row and the move's own checkpoint, newest first.
  expect(listed.map((entry) => entry.label ?? null)).toEqual([null, 'as drafted'])
  expect(listed[1]?.id).toBe(DRAFTED_VERSION_ID)
  expect(listed[1]?.createdAt).toBe(new Date(1_000).toISOString())

  const restored = await app.request(
    `/api/workspaces/session1/documents/notes/roadmap/versions/${DRAFTED_VERSION_ID}/restore`,
    { method: 'POST' },
  )
  expect(restored.status).toBe(200)
  const workspaceDoc = await serverDeps.workspaceDocuments.get('session1')
  expect(readMarkdownBody(documentContainers(workspaceDoc, ROADMAP_ID))).toBe('# as drafted')
})

it('keeps a re-run idempotent: the carried version is not listed twice', async () => {
  const { promote } = harness()
  const record = browserRecordWithTrashAndVersion()
  expect((await promote(record)).status).toBe(200)
  expect((await promote(record)).status).toBe(200)
  const listed = await new FileVersionStore().list('session1', 'notes/roadmap')
  expect(listed.filter((entry) => entry.id === DRAFTED_VERSION_ID)).toHaveLength(1)
})

it('refuses a version whose frontier the record does not hold, and merges nothing', async () => {
  const { promote, documents } = harness()
  const record = browserRecordWithTrashAndVersion()
  const stranger = new LoroDoc()
  stranger.setPeerId(9n)
  stranger.getText('t').insert(0, 'elsewhere')
  stranger.commit()
  const res = await promote({
    ...record,
    versions: [
      { ...record.versions[0], frontiers: b64u(encodeFrontiers(stranger.oplogFrontiers())) },
    ],
  })
  expect(res.status).toBe(400)
  expect(await documents()).toEqual([])
})

it('confirms every carried version on a re-run after the daemon took a checkpoint of its own', async () => {
  const { promote } = harness()
  const record = browserRecordWithTrashAndVersion()
  const { label: _label, ...base } = record.versions[0] ?? {}
  // The browser keeps the same cap the daemon does, so it can carry a full one.
  const autos = Array.from({ length: 50 }, (_, i) => ({
    ...base,
    id: `01BRWAUTOAAAAAAAAAAAAAA${String(i).padStart(3, '0')}`,
    auto: true,
    createdAt: 1_000 + i,
  }))
  const body = { ...record, versions: autos }
  const ids = autos.map((version) => version.id)
  const first = promoteWorkspaceResponseSchema.parse(await (await promote(body)).json())
  expect([...first.versionsKept].sort()).toEqual(ids)

  const doc = await serverDeps.liveDocuments.get('session1', 'notes/roadmap')
  await serverDeps.versions.save('session1', 'notes/roadmap', doc, { auto: true })

  const second = promoteWorkspaceResponseSchema.parse(await (await promote(body)).json())
  expect([...second.versionsKept].sort()).toEqual(ids)
})

it('refuses a carried version naming a body past the markdown limit with 413, and merges nothing', async () => {
  const { promote, documents } = harness()
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
  })
  const body = documentContainers(doc, ROADMAP_ID)
  const half = Math.ceil((MARKDOWN_MAX_CHARS + 1) / 2)
  // Grown in two prepended pieces, so no single insert is past the one-write bound.
  writeMarkdownBody(body, 'a'.repeat(half))
  writeMarkdownBody(body, 'b'.repeat(half) + 'a'.repeat(half))
  const oversized = encodeFrontiers(doc.oplogFrontiers())
  writeMarkdownBody(body, '# short again')
  const res = await promote({
    snapshot: b64u(new Uint8Array(doc.export({ mode: 'snapshot' }))),
    versions: [
      {
        id: DRAFTED_VERSION_ID,
        documentId: ROADMAP_ID,
        createdAt: 1_000,
        auto: false,
        frontiers: b64u(oversized),
      },
    ],
  })
  expect(res.status).toBe(413)
  const answered = (await res.json()) as { error: string; message: string }
  expect(answered.error).toBe('markdown_too_large')
  expect(answered.message).toMatch(/^The document at "notes\/roadmap" /)
  expect(await documents()).toEqual([])
})

it.each([
  ['a person', { kind: 'human', displayName: 'Mallory' }],
  ['an agent', { kind: 'ai', displayName: 'Mallory', agentId: 'mallory-agent' }],
  ['nobody', undefined],
] as const)('names the calling member on a carried version stating %s, and dates none after the move', async (_case, stated) => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 60_000,
      callerName: async () => 'Ada',
    }),
  )
  const record = browserRecordWithTrashAndVersion()
  const [version] = record.versions
  const future = Date.now() + 365 * 24 * 60 * 60 * 1000
  const res = await app.request('/api/w/session1/workspace-document/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...record,
      versions: [{ ...version, createdAt: future, ...(stated && { operator: stated }) }],
    }),
  })
  expect(res.status).toBe(200)
  const carried = (await new FileVersionStore().list('session1', 'notes/roadmap')).find(
    (entry) => entry.id === DRAFTED_VERSION_ID,
  )
  expect(carried?.operator).toEqual({ kind: 'human', displayName: 'Ada' })
  expect(Date.parse(carried?.createdAt ?? '')).toBeLessThanOrEqual(Date.now())
})

it('keeps the operator and date a carried version states on the local daemon', async () => {
  const { promote } = harness()
  const record = browserRecordWithTrashAndVersion()
  const [version] = record.versions
  const operator = { kind: 'human', displayName: 'Yuki' } as const
  expect((await promote({ ...record, versions: [{ ...version, operator }] })).status).toBe(200)
  const carried = (await new FileVersionStore().list('session1', 'notes/roadmap')).find(
    (entry) => entry.id === DRAFTED_VERSION_ID,
  )
  expect(carried?.operator).toEqual(operator)
  expect(carried?.createdAt).toBe(new Date(1_000).toISOString())
})

it('answers a restore of a saved state past a sync limit with 413 in the sync refusal code, writing nothing', async () => {
  const { app } = harness()
  const oversized = new LoroDoc()
  writeSpatialCanvas(oversized, {
    nodes: Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) =>
      textNode({ id: `n${i}`, text: 'n', x: 0, y: 0, width: 1, height: 1 }),
    ),
    edges: [],
  })
  // Stored past the sync judge, as a carried version once was.
  await serverDeps.liveDocuments.save('session1', 'canvas-a', oversized, { kind: 'spatial' })
  const version = await serverDeps.versions.save('session1', 'canvas-a', oversized, {
    auto: false,
  })
  const live = await serverDeps.liveDocuments.get('session1', 'canvas-a')
  writeSpatialCanvas(live, {
    nodes: [textNode({ id: 'kept', text: 'k', x: 0, y: 0, width: 1, height: 1 })],
    edges: [],
  })
  await serverDeps.liveDocuments.save('session1', 'canvas-a', live, { overwrite: true })

  const res = await app.request(
    `/api/workspaces/session1/documents/canvas-a/versions/${version.id}/restore`,
    { method: 'POST' },
  )
  expect(res.status).toBe(413)
  expect(await res.json()).toMatchObject({ error: 'too_many_nodes_or_edges' })
  const after = await serverDeps.liveDocuments.get('session1', 'canvas-a')
  expect(readSpatialCanvas(after).nodes.map((node) => node.id)).toEqual(['kept'])
})
