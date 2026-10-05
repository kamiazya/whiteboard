/**
 * The promote route: the same merge as workspace-document/update, plus one
 * explicit human checkpoint per promoted document. No keeper holds a passkey
 * pin (ADR-0050 decision 3), so an attestation sent beside the bytes names a
 * credential nothing here can check, and is refused before anything lands.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promoteWorkspaceResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
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
  expect(promoteWorkspaceResponseSchema.parse(await res.json()).attested).toBe(false)
  expect(await documents()).toHaveLength(2)
  const versions = await new FileVersionStore().list('session1', 'sketch')
  expect(versions).toHaveLength(1)
  expect(versions[0]?.auto).toBe(false)
  expect(versions[0]?.operator?.kind).toBe('human')
  expect(versions[0]?.attestation).toBeUndefined()
})

it('refuses an attestation, since no passkey is pinned here, and merges nothing', async () => {
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
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'attestation_rejected', message: 'unknownCredential' })
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
