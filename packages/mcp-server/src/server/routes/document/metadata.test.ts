import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { answerUnhandled } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  documentIdAt,
  resolveTestServerDeps,
  testStoreScope,
  UNKNOWN_DOCUMENT_ID,
  withTempDataDir,
} from '../_test-helpers.js'
import { refuseCorruptStored } from './_shared.js'

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
const { createDocumentMetadataRouter: createMetadataRouter } = await import('./metadata.js')
const { resolveDocumentAddress } = await import('./path-route.js')

const WORKSPACE = '011K0CCH776JA60YJHJTYXASRK'

// The composed document router resolves a document id once ahead of every
// id-addressed route; mounting the metadata router alone needs the same step.
function createDocumentMetadataRouter(options: Parameters<typeof createMetadataRouter>[0]): Hono {
  const app = new Hono().onError(answerUnhandled(() => {}))
  app.use(
    '/api/workspaces/:workspaceId/documents/:documentId/*',
    resolveDocumentAddress(serverDeps, refuseCorruptStored),
  )
  app.route('/', createMetadataRouter(options))
  return app
}

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
    await createTestDocument(serverDeps, {
      workspaceId: '011K0CCH776JA60YJHJTYXASRK',
      path: 'real',
      kind: 'markdown',
    })
  })

  it.each([
    ['name', { name: 'Renamed' }],
    ['pin', { pinned: true }],
  ])('answers 404 not_found instead of minting a row for %s', async (action, body) => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })
    const res = await put(
      app,
      `/api/workspaces/${WORKSPACE}/documents/${UNKNOWN_DOCUMENT_ID}/${action}`,
      body,
    )
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' })
  })

  it('lets the document that exists through', async () => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })
    const id = await documentIdAt(serverDeps, WORKSPACE, 'real')
    const res = await put(app, `/api/workspaces/${WORKSPACE}/documents/${id}/name`, {
      name: 'Renamed',
    })
    expect(res.status).toBe(200)
  })
})

describe('metadata routes over a workspace record this server cannot read', () => {
  let realId = ''
  beforeEach(async () => {
    await mkdir(join(tmp.dir, '011K0CCH776JA60YJHJTYXASRK'), { recursive: true })
    const { getDb } = await import('../../store/db/index.js')
    const { LibsqlDocumentStore } = await import('../../store/libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { saveDocument } = await import('../../store/document-store.js')
    await saveDocument('011K0CCH776JA60YJHJTYXASRK', 'real', new LoroDoc())
    realId = await documentIdAt(serverDeps, WORKSPACE, 'real')
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await new LibsqlDocumentStore(await getDb(tmp.dir)).saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: '011K0CCH776JA60YJHJTYXASRK' },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })
    const { _clearWorkspaceDocCacheForTests } = await import('../../store/document-store.js')
    _clearWorkspaceDocCacheForTests()
  })

  it.each([
    [
      'read names',
      'GET',
      '/api/workspaces/011K0CCH776JA60YJHJTYXASRK/names',
      undefined,
      'corrupt_stored_data',
    ],
    [
      'set the workspace name',
      'PUT',
      '/api/workspaces/011K0CCH776JA60YJHJTYXASRK/name',
      { name: 'N' },
      'corrupt_stored_data',
    ],
    // The id is resolved before the handler runs, so the record that cannot
    // be opened is met there, and answered in the same words.
    [
      'set a document name',
      'PUT',
      (id: string) => `/documents/${id}/name`,
      { name: 'N' },
      'corrupt_stored_data',
    ],
    [
      'pin a document',
      'PUT',
      (id: string) => `/documents/${id}/pin`,
      { pinned: true },
      'corrupt_stored_data',
    ],
  ] as const)('answers a structured 500 to %s', async (_label, method, target, body, code) => {
    const url =
      typeof target === 'string'
        ? target
        : `/api/workspaces/011K0CCH776JA60YJHJTYXASRK${target(realId)}`
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
    await expect(res.json()).resolves.toMatchObject({ error: code })
  })
})

describe('PUT …/documents/:documentId/name with a name a sibling already shows', () => {
  beforeEach(async () => {
    await createTestDocument(serverDeps, {
      workspaceId: '011K0CCH776JA60YJHJTYXASRK',
      path: 'week/plan',
      name: 'Plan',
    })
    await createTestDocument(serverDeps, {
      workspaceId: '011K0CCH776JA60YJHJTYXASRK',
      path: 'week/other',
    })
    await createTestDocument(serverDeps, {
      workspaceId: '011K0CCH776JA60YJHJTYXASRK',
      path: 'month/plan',
    })
  })

  it('answers 409 display_name_taken and leaves the name as it was', async () => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })

    const id = await documentIdAt(serverDeps, WORKSPACE, 'week/other')
    const res = await put(app, `/api/workspaces/${WORKSPACE}/documents/${id}/name`, {
      name: 'plan',
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: 'display_name_taken' })
    const names = await (
      await app.request('/api/workspaces/011K0CCH776JA60YJHJTYXASRK/names')
    ).json()
    expect(Object.values(names.documents)).toEqual(['Plan'])
  })

  it('lets the same name through in another folder', async () => {
    const app = createDocumentMetadataRouter({ scope: testStoreScope() })
    const id = await documentIdAt(serverDeps, WORKSPACE, 'month/plan')
    const res = await put(app, `/api/workspaces/${WORKSPACE}/documents/${id}/name`, {
      name: 'Plan',
    })
    expect(res.status).toBe(200)
  })
})
