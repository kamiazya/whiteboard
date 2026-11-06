import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-live-doc-test-')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir.
let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  // The document routes address a workspace that exists; none is minted from a handle.
  await serverDeps.documentIndex.createWorkspace({ workspaceId: 'session1' })
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
  await mkdir(join(tmp.dir, 'session1'), { recursive: true })
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

describe('GET /api/w/:workspaceId/document/:path/snapshot', () => {
  it('returns the Loro snapshot binary', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'elem-001')
    doc.commit()
    await saveDocument('session1', 'canvas-a', doc)

    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const res = await app.request('/api/w/session1/document/canvas-a/snapshot')
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

  it('returns 400 for an invalid path', async () => {
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const res = await app.request('/api/w/session1/document/bad.path/snapshot')
    expect(res.status).toBe(400)
  })

  it('returns 404 { error, message } for a canvas that was never created', async () => {
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    const res = await app.request('/api/w/session1/document/never-created/snapshot')
    expect(res.status).toBe(404)
    // The same body family as the workspace refusal in front of this route;
    // a document of either kind lives at this path, so the message names none.
    expect(await res.json()).toEqual({
      error: 'not_found',
      message: 'Document "never-created" not found',
    })
  })

  it('returns 404 for a canvas that existed and was deleted', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    await app.request('/api/workspaces/session1/documents/canvas-a', { method: 'DELETE' })

    const res = await app.request('/api/w/session1/document/canvas-a/snapshot')
    expect(res.status).toBe(404)
  })
})
