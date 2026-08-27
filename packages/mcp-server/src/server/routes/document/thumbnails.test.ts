import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-thumbnails-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearCache } = await import('../../store/doc-cache.js')
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import(
  '../../store/document-store.js'
)
const { LoroDoc } = await import('loro-crdt')
const { createThumbnailsRouter } = await import('./thumbnails.js')
const { createDocumentRouter } = await import('../document.js')

describe('thumbnails router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createThumbnailsRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})

describe('thumbnail PUT/GET endpoints', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
    clearCache()
    _clearWorkspaceDocCacheForTests()
    // Version save refuses a path with no document; seed the canvases the
    // routes below checkpoint — the shape production always has.
    await saveDocument('session1', 'canvas-a', new LoroDoc(), { kind: 'spatial' })
  })
  afterEach(() => {
    clearCache()
  })

  it('saves a PNG through PUT /versions/:id/thumbnail and fetches it through GET', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    const id = saveBody.version.id

    // Minimal bytes starting with the PNG signature.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const putRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${id}/thumbnail`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: png,
      },
    )
    expect(putRes.status).toBe(200)

    const getRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${id}/thumbnail`,
    )
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await getRes.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(png))
  })

  it('rejects an oversized thumbnail body with 413 payload_too_large', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    const id = saveBody.version.id

    const oversized = new Uint8Array(16 * 1024 * 1024 + 1)
    const putRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${id}/thumbnail`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: oversized,
      },
    )
    expect(putRes.status).toBe(413)
    const body: unknown = await putRes.json()
    expect(body).toMatchObject({ error: 'payload_too_large' })
  })

  it('rejects non-PNG magic bytes such as JPEG with 400 on PUT /thumbnail', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    // JPEG signature (FF D8 FF)
    const notPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const res = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/thumbnail`,
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: notPng },
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unsaved thumbnail id on GET /thumbnail', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/documents/canvas-a/versions/no-thumb/thumbnail',
    )
    expect(res.status).toBe(404)
  })

  // GET /latest-thumbnail is consumed by DocumentThumb's <img src>. A 404 makes
  // the browser log "Failed to load resource: 404" for every thumbnail-less
  // canvas, which is console noise (the component already has an onError
  // fallback). Returning 204 No Content is a success status, so no console
  // error is logged, while the empty body still triggers <img> onError → the
  // FileText placeholder.
  it('returns 204 (not 404) from GET /latest-thumbnail when the canvas has no thumbnail', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/latest-thumbnail')
    expect(res.status).toBe(204)
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0))
  })

  it('returns 204 from GET /latest-thumbnail when metadata claims a thumbnail but the blob is gone', async () => {
    // A version is listed as hasThumbnail=true but loadThumbnail resolves null
    // (blob pruned/missing without throwing). This is the second 204 branch,
    // distinct from "no thumbnailed version exists": the <img> still needs a
    // success status to avoid 404 console noise.
    const versionStore = {
      save: vi.fn(),
      load: vi.fn(),
      list: vi.fn().mockResolvedValue([{ id: 'v1', hasThumbnail: true }]),
      saveThumbnail: vi.fn(),
      loadThumbnail: vi.fn().mockResolvedValue(null),
      getFrontiersBase64: vi.fn(),
      renameBranchInVersions: vi.fn(),
      pruneSandwichedAutoVersions: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [] }),
    } as unknown as Parameters<typeof createDocumentRouter>[0]['versionStore']

    const app = createDocumentRouter({ versionStore })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/latest-thumbnail')
    expect(res.status).toBe(204)
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0))
  })

  it('returns structured 500 for a broken thumbnail file on GET /thumbnail', async () => {
    await mkdir(join(tmp.dir, 'blobs', 'session1', 'versions', 'broken-thumb.png'), {
      recursive: true,
    })

    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/documents/canvas-a/versions/broken-thumb/thumbnail',
    )

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken-thumb.png'),
    })
  })

  it('returns hasThumbnail=true in the version list after saving a thumbnail', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/thumbnail`,
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png },
    )
    const listRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions')
    const listBody = (await listRes.json()) as { versions: Array<{ hasThumbnail: boolean }> }
    expect(listBody.versions[0].hasThumbnail).toBe(true)
  })
})
