import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  documentIdAt,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  UNKNOWN_DOCUMENT_ID,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-live-doc-test-')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir.
let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  // The document routes address a workspace that exists; none is minted from a handle.
  await serverDeps.documentIndex.createWorkspace({ workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF' })
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

const { saveDocument } = await import('../../store/document-store.js')
const { createLiveDocRouter } = await import('./live-doc.js')
const { createDocumentRouter } = await import('../document.js')

beforeEach(async () => {
  await mkdir(join(tmp.dir, '01M8BBN7JS60N0ZAR13NP8SXBF'), { recursive: true })
  clearDocCacheForTests()
})
afterEach(() => {
  clearDocCacheForTests()
})

describe('live-doc router', () => {
  it('returns a Hono instance', () => {
    const app = createLiveDocRouter({ serverDeps })
    expect(app).toBeInstanceOf(Hono)
  })
})

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const snapshotUrl = (documentId: string) => `/api/workspaces/${WS}/documents/${documentId}/snapshot`

describe('GET /api/workspaces/:workspaceId/documents/:documentId/snapshot', () => {
  it('returns the Loro snapshot binary', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'elem-001')
    doc.commit()
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', doc)

    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const res = await app.request(snapshotUrl(await documentIdAt(serverDeps, WS, 'canvas-a')))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/octet-stream')

    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(0)

    // Restore the binary and confirm the element is present.
    const restored = LoroDoc.fromSnapshot(new Uint8Array(buf))
    const elements = restored.getMovableList('elements').toJSON() as { id: string }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('elem-001')
  })

  it('returns 404 { error, message } for an id no document holds', async () => {
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const res = await app.request(snapshotUrl(UNKNOWN_DOCUMENT_ID))
    expect(res.status).toBe(404)
    // The same body family as the workspace refusal in front of this route;
    // a document of either kind lives behind an id, so the message names none.
    expect(await res.json()).toEqual({
      error: 'not_found',
      message: `Document "${UNKNOWN_DOCUMENT_ID}" not found`,
    })
  })

  it('returns 404 for a canvas that existed and was deleted', async () => {
    await saveDocument(WS, 'canvas-a', new LoroDoc())
    const documentId = await documentIdAt(serverDeps, WS, 'canvas-a')
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    await app.request(`/api/workspaces/${WS}/documents/${documentId}`, { method: 'DELETE' })

    const res = await app.request(snapshotUrl(documentId))
    expect(res.status).toBe(404)
  })
})
