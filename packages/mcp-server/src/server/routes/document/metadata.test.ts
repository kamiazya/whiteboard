import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  testStoreScope,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-metadata-test-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
})

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createDocumentMetadataRouter } = await import('./metadata.js')

beforeEach(() => {
  clearDocCacheForTests()
})
afterEach(() => {
  clearDocCacheForTests()
})

const put = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('metadata router', () => {
  it('returns a Hono instance', () => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })
    expect(app).toBeInstanceOf(Hono)
  })
})

describe('metadata writers on a document that is not there', () => {
  beforeEach(async () => {
    await createTestDocument(serverDeps, { workspaceId: 'ws1', path: 'real', kind: 'markdown' })
  })

  it.each([
    ['name', { name: 'Renamed' }],
    ['pin', { pinned: true }],
  ])('answers 404 not_found instead of minting a row for %s', async (action, body) => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })
    const res = await put(app, `/api/workspaces/ws1/documents/ghost/${action}`, body)
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' })
  })

  it('lets the document that exists through', async () => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })
    const res = await put(app, '/api/workspaces/ws1/documents/real/name', { name: 'Renamed' })
    expect(res.status).toBe(200)
  })
})

describe('metadata routes over a workspace record this server cannot read', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'ws1'), { recursive: true })
    const { getDb } = await import('../../store/db/index.js')
    const { LibsqlDocumentStore } = await import('../../store/libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { saveDocument } = await import('../../store/document-store.js')
    await saveDocument('ws1', 'real', new LoroDoc())
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await new LibsqlDocumentStore(await getDb(tmp.dir)).saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: 'ws1' },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })
    const { _clearWorkspaceDocCacheForTests } = await import('../../store/document-store.js')
    _clearWorkspaceDocCacheForTests()
  })

  it.each([
    ['read names', 'GET', '/api/workspaces/ws1/names', undefined],
    ['set the workspace name', 'PUT', '/api/workspaces/ws1/name', { name: 'N' }],
    ['set a document name', 'PUT', '/api/workspaces/ws1/documents/real/name', { name: 'N' }],
    ['pin a document', 'PUT', '/api/workspaces/ws1/documents/real/pin', { pinned: true }],
  ] as const)('answers a structured 500 to %s', async (_label, method, url, body) => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })
    const res =
      method === 'GET'
        ? await app.request(url)
        : await app.request(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: 'corrupt_stored_data' })
  })
})
