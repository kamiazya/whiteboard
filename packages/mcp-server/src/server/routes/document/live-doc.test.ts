import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateDocumentResponseSchema } from '../../../shared/api-contracts/document.js'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-live-doc-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearCache, peekDoc } = await import('../../store/doc-cache.js')

const { getDoc, saveDocument, loadDocument } = await import('../../store/document-store.js')
const { createLiveDocRouter } = await import('./live-doc.js')
const { createDocumentRouter } = await import('../document.js')

beforeEach(async () => {
  await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  clearCache()
})
afterEach(() => {
  clearCache()
})

describe('live-doc router', () => {
  it('returns a Hono instance', () => {
    const triggerAutoVersion = vi.fn()
    const app = createLiveDocRouter({ triggerAutoVersion })
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

    const app = createDocumentRouter()
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
    const app = createDocumentRouter()
    const res = await app.request('/api/w/session1/document/bad.path/snapshot')
    expect(res.status).toBe(400)
  })

  it('returns 404 with Problem Details { title } for a canvas that was never created', async () => {
    const app = createDocumentRouter()
    const res = await app.request('/api/w/session1/document/never-created/snapshot')
    expect(res.status).toBe(404)
    const json = (await res.json()) as { title?: string }
    // Same shape as DELETE's 404 — the client parses problem-details for
    // both routes — deliberately not thumbnails/restore's { error, message }.
    expect(typeof json.title).toBe('string')
    expect(json.title!.length).toBeGreaterThan(0)
    expect(json).not.toHaveProperty('error')
  })

  it('returns 404 for a canvas that existed and was deleted', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const app = createDocumentRouter()
    await app.request('/api/workspaces/session1/documents/canvas-a', { method: 'DELETE' })

    const res = await app.request('/api/w/session1/document/canvas-a/snapshot')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/w/:workspaceId/document/:path/exists', () => {
  it('returns exists:true for a canvas that was actually saved', async () => {
    const doc = new LoroDoc()
    await saveDocument('session1', 'canvas-a', doc)

    const app = createDocumentRouter()
    const res = await app.request('/api/w/session1/document/canvas-a/exists')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: true })
  })

  it('returns exists:false for an unregistered canvas without creating it', async () => {
    const app = createDocumentRouter()
    const res = await app.request('/api/w/session1/document/never-created/exists')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false })

    // GET /exists must never have the getDoc/loadDocument side effect that
    // /snapshot has: the canvas should still be absent afterward.
    const followUp = await app.request('/api/w/session1/document/never-created/exists')
    expect(await followUp.json()).toEqual({ exists: false })
  })

  it('returns 400 for an invalid path', async () => {
    const app = createDocumentRouter()
    const res = await app.request('/api/w/session1/document/bad.path/exists')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/w/:workspaceId/document/:path/update', () => {
  it('applies a Loro update to the document', async () => {
    // Create the change in the client-side doc.
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'elem-from-client')
    map.set('type', 'ellipse')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    const app = createDocumentRouter()
    const res = await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(res.status).toBe(200)
    // Pin the shared contract: the response body must parse under the
    // Zod schema the web import client consumes, not just an ad-hoc shape.
    const body: unknown = await res.json()
    expect(updateDocumentResponseSchema.safeParse(body).success).toBe(true)

    // Clear the cache, reload, and confirm the change was persisted.
    clearCache()
    const serverDoc = await loadDocument('session1', 'canvas-a')
    const elements = serverDoc.getMovableList('elements').toJSON() as { id: string; type: string }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('elem-from-client')
    expect(elements[0].type).toBe('ellipse')
  })

  it('rejects an oversized update body with 413 payload_too_large', async () => {
    const app = createDocumentRouter()
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1)
    const res = await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: oversized,
    })
    expect(res.status).toBe(413)
    const body: unknown = await res.json()
    expect(body).toMatchObject({ error: 'payload_too_large' })
  })

  it('evicts the cached doc when saveDocument fails, so a subsequent read does not serve the unpersisted update', async () => {
    const app = createDocumentRouter()

    // Persist an initial one-element state directly.
    const initial = new LoroDoc()
    const initialList = initial.getMovableList('elements')
    const initialElem = initialList.insertContainer(0, new LoroMap())
    initialElem.set('id', 'persisted')
    initial.commit()
    await saveDocument('session1', 'canvas-a', initial)

    // Pull it into the doc-cache so there is a live cached doc to poison.
    await app.request('/api/w/session1/document/canvas-a/snapshot')
    expect(peekDoc('session1', 'canvas-a')).toBeDefined()

    // Build a client update that adds a second element.
    const clientDoc = LoroDoc.fromSnapshot(initial.export({ mode: 'snapshot' }))
    const prevVV = clientDoc.version()
    const clientList = clientDoc.getMovableList('elements')
    const clientElem = clientList.insertContainer(clientList.length, new LoroMap())
    clientElem.set('id', 'unpersisted')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    // Force the persistence step inside saveDocument to fail after doc.import()
    // has already mutated the cached doc.
    const exportSpy = vi.spyOn(LoroDoc.prototype, 'export').mockImplementationOnce(() => {
      throw new Error('simulated snapshot failure')
    })
    const res = await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    exportSpy.mockRestore()

    expect(res.status).toBe(500)
    // The cache must be evicted: without eviction, the in-memory doc already
    // absorbed the update even though saveDocument never persisted it.
    expect(peekDoc('session1', 'canvas-a')).toBeUndefined()

    const reloaded = await getDoc('session1', 'canvas-a')
    const ids = (reloaded.getMovableList('elements').toJSON() as Array<{ id: string }>).map(
      (el) => el.id,
    )
    expect(ids).toEqual(['persisted'])
  })
})
