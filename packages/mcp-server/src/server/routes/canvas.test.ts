import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

// Mock doc-cache so the cache is isolated in tests.
vi.mock('../store/doc-cache.js', async () => {
  const actual = await vi.importActual<typeof import('../store/doc-cache.js')>(
    '../store/doc-cache.js',
  )
  return actual
})

const { clearCache } = await import('../store/doc-cache.js')
const { saveCanvas } = await import('../store/canvas-store.js')
const { corruptStoredData } = await import('../store/corrupt-stored-data.js')

// Dynamically import the Hono app.
const { createCanvasRouter, createAutoVersionTrigger } = await import('./canvas.js')

describe('GET /api/workspaces', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  // listWorkspaces no longer walks DATA_DIR, so the previous corruption-on-disk
  // assertion no longer applies. The DB-backed equivalent is exercised through
  // unit tests on canvas-store directly.
})

describe('GET /api/workspaces', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('returns the canonical workspace list with workspaceId entries', async () => {
    await saveCanvas('workspace-a', 'a', new LoroDoc())
    const app = createCanvasRouter()
    const res = await app.request('/api/workspaces')

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      workspaces: Array<{ workspaceId: string; daemonAlive: boolean }>
    }
    expect(json.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: 'workspace-a',
        daemonAlive: false,
      }),
    ])
  })
})

describe('GET /api/workspaces/:workspaceId/canvases', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('returns the canvas list', async () => {
    await saveCanvas('session1', 'canvas-a', new LoroDoc())
    await saveCanvas('session1', 'canvas-b', new LoroDoc())

    const app = createCanvasRouter()
    const res = await app.request('/api/workspaces/session1/canvases')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { canvases: { slug: string }[] }
    const slugs = json.canvases.map((c) => c.slug)
    expect(slugs).toContain('canvas-a')
    expect(slugs).toContain('canvas-b')
  })

  it('returns 400 for an invalid workspaceId', async () => {
    const app = createCanvasRouter()
    const res = await app.request('/api/workspaces/bad.sid/canvases')
    expect(res.status).toBe(400)
  })

  // listCanvases no longer walks per-workspace directories, so the previous
  // "broken session directory" 500 case no longer applies.
})

describe('GET /api/workspaces/:workspaceId/canvases', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    await mkdir(join(tempDir, 'workspace1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('also returns the canvas list from the canonical workspace route', async () => {
    await saveCanvas('workspace1', 'canvas-a', new LoroDoc())

    const app = createCanvasRouter()
    const res = await app.request('/api/workspaces/workspace1/canvases')

    expect(res.status).toBe(200)
    const json = (await res.json()) as { canvases: { slug: string }[] }
    expect(json.canvases).toEqual([expect.objectContaining({ slug: 'canvas-a' })])
  })
})

describe('GET /api/canvas/:workspaceId/:slug/snapshot', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('returns the Loro snapshot binary', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'elem-001')
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc)

    const app = createCanvasRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/snapshot')
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

  it('returns 400 for an invalid slug', async () => {
    const app = createCanvasRouter()
    const res = await app.request('/api/canvas/session1/bad.slug/snapshot')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/workspaces/:workspaceId/canvases/:slug/compact', () => {
  function createVersionStoreMock() {
    return {
      save: vi.fn(),
      load: vi.fn(),
      list: vi.fn(),
      saveThumbnail: vi.fn(),
      loadThumbnail: vi.fn(),
      earliestFrontiers: vi.fn().mockResolvedValue([]),
      getFrontiersBase64: vi.fn(),
      renameBranchInVersions: vi.fn(),
    }
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('returns structured 500 for a broken snapshot', async () => {
    const blobDir = join(tempDir, 'blobs', 'session1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, 'canvas-a.loro'), Buffer.from('not-a-loro-snapshot'))

    const app = createCanvasRouter({ versionStore: createVersionStoreMock() })
    const res = await app.request('/api/workspaces/session1/canvases/canvas-a/compact', {
      method: 'POST',
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('canvas-a.loro'),
    })
  })

  // Canvas blobs live under blobs/{workspaceId}/canvas/, so the previous
  // "non-directory session path" stat failure case no longer maps. compact
  // returns no-file for missing blobs, and the corrupt-snapshot case above
  // still exercises the corruption branch.
})

// names-store now lives in the sqlite metadata DB; the corruption-on-disk
// failure modes covered above no longer apply. DB-side error handling is
// exercised through unit tests on names-store directly.

describe('POST /api/canvas/:workspaceId/:slug/update', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

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

    const app = createCanvasRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(res.status).toBe(200)

    // Clear the cache, reload, and confirm the change was persisted.
    clearCache()
    const { loadCanvas } = await import('../store/canvas-store.js')
    const serverDoc = await loadCanvas('session1', 'canvas-a')
    const elements = serverDoc.getMovableList('elements').toJSON() as { id: string; type: string }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('elem-from-client')
    expect(elements[0].type).toBe('ellipse')
  })
})

// Version API coverage: auto-save on update, list, manual save, and restore.
describe('versions API', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('saves an auto-version immediately when autoVersionIntervalMs=0', async () => {
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const m = list.insertContainer(0, new LoroMap())
    m.set('id', 'e1')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    const app = createCanvasRouter({ autoVersionIntervalMs: 0 })
    const resUpdate = await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(resUpdate.status).toBe(200)

    // Auto-version saving is best-effort and async, so wait briefly.
    await new Promise((r) => setTimeout(r, 50))

    const resList = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')
    expect(resList.status).toBe(200)
    const body = (await resList.json()) as { versions: Array<{ auto: boolean; elementCount: number }> }
    expect(body.versions.length).toBeGreaterThanOrEqual(1)
    expect(body.versions[0].auto).toBe(true)
    expect(body.versions[0].elementCount).toBe(1)
  })

  it('saves a manual version with a label through POST /versions', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'before refactor' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { version: { auto: boolean; label?: string } }
    expect(body.version.auto).toBe(false)
    expect(body.version.label).toBe('before refactor')
  })

  it('POST /versions persists an explicit operator', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'ai save',
        operator: {
          kind: 'ai',
          peerId: 'peer-ai',
          displayName: 'Assistant',
          agentId: 'agent-1',
        },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: { operator?: { kind: string; peerId: string; displayName?: string; agentId?: string } }
    }
    expect(body.version.operator).toEqual({
      kind: 'ai',
      peerId: 'peer-ai',
      displayName: 'Assistant',
      agentId: 'agent-1',
    })

    const listRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')
    const listBody = (await listRes.json()) as {
      versions: Array<{ operator?: { kind: string; peerId: string; displayName?: string; agentId?: string } }>
    }
    expect(listBody.versions[0]?.operator).toEqual(body.version.operator)
  })

  it('POST /versions defaults operator to human when omitted', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'manual save' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: { operator?: { kind: string; peerId: string; displayName?: string } }
    }
    expect(body.version.operator?.kind).toBe('human')
    expect(body.version.operator?.peerId).toMatch(/\S+/)
    expect(body.version.operator?.displayName).toBe(userInfo().username)
  })

  it('POST /update auto-version persists system/auto-save operator', async () => {
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const m = list.insertContainer(0, new LoroMap())
    m.set('id', 'e-auto')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    const app = createCanvasRouter({ autoVersionIntervalMs: 0 })
    const resUpdate = await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(resUpdate.status).toBe(200)

    await new Promise((r) => setTimeout(r, 50))

    const resList = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')
    const body = (await resList.json()) as {
      versions: Array<{ operator?: { kind: string; peerId: string; displayName?: string } }>
    }
    expect(body.versions[0]?.operator).toMatchObject({
      kind: 'system',
      displayName: 'auto-save',
    })
    expect(body.versions[0]?.operator?.peerId).toMatch(/\S+/)
  })

  it('restores the past-state element set through POST /versions/:id/restore', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })

    // Step 1: Write the initial one-element state through /update.
    const initial = new LoroDoc()
    const vv0 = initial.version()
    const list = initial.getMovableList('elements')
    const m0 = list.insertContainer(list.length, new LoroMap())
    m0.set('id', 'keep-me')
    m0.set('type', 'rectangle')
    initial.commit()
    await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv0 }),
    })

    // Step 2: Save the current one-element state as v1.
    const saveRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    const v1id = saveBody.version.id

    // Step 3: Add two more elements after v1.
    const vv1 = initial.version()
    const m1 = list.insertContainer(list.length, new LoroMap())
    m1.set('id', 'added-1')
    m1.set('type', 'ellipse')
    const m2 = list.insertContainer(list.length, new LoroMap())
    m2.set('id', 'added-2')
    m2.set('type', 'diamond')
    initial.commit()
    await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv1 }),
    })

    // Step 4: Restore v1. keep-me should remain and added-* should become tombstones.
    const resRestore = await app.request(
      `/api/workspaces/session1/canvases/canvas-a/versions/${v1id}/restore`,
      { method: 'POST' },
    )
    expect(resRestore.status).toBe(200)

    // Step 5: Reload the server canvas doc and verify the tombstone state.
    clearCache()
    const { loadCanvas } = await import('../store/canvas-store.js')
    const serverDoc = await loadCanvas('session1', 'canvas-a')
    const elements = serverDoc.getMovableList('elements').toJSON() as Array<{
      id: string
      isDeleted?: boolean
    }>
    const alive = elements.filter((e) => !e.isDeleted)
    const aliveIds = alive.map((e) => e.id).sort()
    expect(aliveIds).toEqual(['keep-me'])
    // The tombstoned added-* entries should still exist in the CRDT log.
    const deleted = elements.filter((e) => e.isDeleted === true).map((e) => e.id)
    expect(deleted).toContain('added-1')
    expect(deleted).toContain('added-2')
  })

  it('removes optional fields that did not exist at save time during restore', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })

    const doc = new LoroDoc()
    const vv0 = doc.version()
    const list = doc.getMovableList('elements')
    const rect = list.insertContainer(0, new LoroMap())
    rect.set('id', 'keep-me')
    rect.set('type', 'rectangle')
    rect.set('x', 0)
    rect.set('y', 0)
    doc.commit()

    await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: doc.export({ mode: 'update', from: vv0 }),
    })

    const saveRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'before-link' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const vv1 = doc.version()
    rect.set('link', 'https://example.com')
    rect.set('frameId', 'frame-1')
    doc.commit()
    await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: doc.export({ mode: 'update', from: vv1 }),
    })

    const restoreRes = await app.request(
      `/api/workspaces/session1/canvases/canvas-a/versions/${saveBody.version.id}/restore`,
      { method: 'POST' },
    )
    expect(restoreRes.status).toBe(200)

    clearCache()
    const { loadCanvas } = await import('../store/canvas-store.js')
    const restored = await loadCanvas('session1', 'canvas-a')
    const elements = restored.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    const keepMe = elements.find((el) => el.id === 'keep-me')
    expect(keepMe?.link).toBeUndefined()
    expect(keepMe?.frameId).toBeUndefined()
  })

  it('returns structured 500 instead of not_found for broken version metadata in GET /versions', async () => {
    await mkdir(join(tempDir, 'session1', 'versions'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'versions', 'broken-list.json'), '{"slug":')

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken-list.json'),
    })
  })

  it('returns 404 when restoring a missing version id', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/versions/nonexistent/restore',
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for an invalid version id', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/versions/bad.id/restore',
      { method: 'POST' },
    )
    expect(res.status).toBe(400)
  })

  it('does not collapse broken version metadata to 404 during restore', async () => {
    await mkdir(join(tempDir, 'session1', 'versions'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'versions', 'brokenrestore.json'), '{"slug":')

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/versions/brokenrestore/restore',
      { method: 'POST' },
    )

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('brokenrestore.json'),
    })
  })

  // Thumbnail PUT/GET endpoint coverage.
  it('saves a PNG through PUT /versions/:id/thumbnail and fetches it through GET', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    const id = saveBody.version.id

    // Minimal bytes starting with the PNG signature.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const putRes = await app.request(
      `/api/workspaces/session1/canvases/canvas-a/versions/${id}/thumbnail`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: png,
      },
    )
    expect(putRes.status).toBe(200)

    const getRes = await app.request(
      `/api/workspaces/session1/canvases/canvas-a/versions/${id}/thumbnail`,
    )
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await getRes.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(png))
  })

  it('rejects non-PNG magic bytes such as JPEG with 400 on PUT /thumbnail', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    // JPEG signature (FF D8 FF)
    const notPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const res = await app.request(
      `/api/workspaces/session1/canvases/canvas-a/versions/${saveBody.version.id}/thumbnail`,
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: notPng },
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unsaved thumbnail id on GET /thumbnail', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/versions/no-thumb/thumbnail',
    )
    expect(res.status).toBe(404)
  })

  it('returns structured 500 for a broken thumbnail file on GET /thumbnail', async () => {
    await mkdir(join(tempDir, 'session1', 'versions', 'broken-thumb.png'), { recursive: true })

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/versions/broken-thumb/thumbnail',
    )

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken-thumb.png'),
    })
  })

  it('returns hasThumbnail=true in the version list after saving a thumbnail', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await app.request(
      `/api/workspaces/session1/canvases/canvas-a/versions/${saveBody.version.id}/thumbnail`,
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png },
    )
    const listRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')
    const listBody = (await listRes.json()) as { versions: Array<{ hasThumbnail: boolean }> }
    expect(listBody.versions[0].hasThumbnail).toBe(true)
  })

  it('filters GET /versions by slug and returns newest first', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      body: JSON.stringify({ label: 'a1' }),
      headers: { 'Content-Type': 'application/json' },
    })
    await app.request('/api/workspaces/session1/canvases/canvas-b/versions', {
      method: 'POST',
      body: JSON.stringify({ label: 'b1' }),
      headers: { 'Content-Type': 'application/json' },
    })

    const resA = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')
    const bodyA = (await resA.json()) as { versions: Array<{ label?: string }> }
    expect(bodyA.versions.map((v) => v.label)).toEqual(['a1'])

    const resB = await app.request('/api/workspaces/session1/canvases/canvas-b/versions')
    const bodyB = (await resB.json()) as { versions: Array<{ label?: string }> }
    expect(bodyB.versions.map((v) => v.label)).toEqual(['b1'])
  })

  it('returns structured 500 for broken thumbnail reads on GET /latest-thumbnail', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const saveRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    await mkdir(join(tempDir, 'session1', 'versions', `${saveBody.version.id}.png`), {
      recursive: true,
    })

    const res = await app.request('/api/workspaces/session1/canvases/canvas-a/latest-thumbnail')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining(`${saveBody.version.id}.png`),
    })
  })

  it('restores a checkpoint back into a canvas', async () => {
    const { FileCheckpointStore } = await import('../store/checkpoint-store.js')
    const store = new FileCheckpointStore()
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'restored-1')
    map.set('type', 'rectangle')
    map.set('x', 0)
    map.set('y', 0)
    map.set('width', 10)
    map.set('height', 10)
    doc.commit()
    await store.save('cp-known', doc)

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/checkpoints/cp-known/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSlug: 'restored-canvas' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      canvasId: 'session1/restored-canvas',
      elementCount: 1,
    })

    clearCache()
    const { loadCanvas } = await import('../store/canvas-store.js')
    const restored = await loadCanvas('session1', 'restored-canvas')
    const elements = restored.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    expect(elements.map((el) => el.id)).toEqual(['restored-1'])
  })

  it('excludes tombstones from elementCount when restoring a checkpoint', async () => {
    const { FileCheckpointStore } = await import('../store/checkpoint-store.js')
    const store = new FileCheckpointStore()
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const live = list.insertContainer(0, new LoroMap())
    live.set('id', 'live-1')
    live.set('type', 'rectangle')
    live.set('x', 0)
    live.set('y', 0)
    live.set('width', 10)
    live.set('height', 10)
    const deleted = list.insertContainer(1, new LoroMap())
    deleted.set('id', 'deleted-1')
    deleted.set('type', 'rectangle')
    deleted.set('x', 20)
    deleted.set('y', 0)
    deleted.set('width', 10)
    deleted.set('height', 10)
    deleted.set('isDeleted', true)
    doc.commit()
    await store.save('cp-known-live-only', doc)

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/checkpoints/cp-known-live-only/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSlug: 'restored-live-only' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      canvasId: 'session1/restored-live-only',
      elementCount: 1,
    })
  })

  it('does not collapse broken checkpoints to 404 during restore', async () => {
    await mkdir(join(tempDir, '.checkpoints'), { recursive: true })
    await writeFile(join(tempDir, '.checkpoints', 'cp-broken.loro'), new Uint8Array([1, 2, 3, 4]))

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/checkpoints/cp-broken/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSlug: 'restored-canvas' }),
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('cp-broken.loro'),
    })
  })

  it('saves a checkpoint from a canvas', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'saved-1')
    map.set('type', 'rectangle')
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc)

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlug: 'canvas-a', checkpointId: 'cp-save' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      checkpointId: 'cp-save',
      elementCount: 1,
    })

    const { FileCheckpointStore } = await import('../store/checkpoint-store.js')
    const store = new FileCheckpointStore()
    const saved = await store.load('cp-save')
    expect(saved?.getMovableList('elements').toJSON()).toHaveLength(1)
  })

  it('excludes tombstones from elementCount when saving a checkpoint', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const live = list.insertContainer(0, new LoroMap())
    live.set('id', 'saved-live')
    live.set('type', 'rectangle')
    const deleted = list.insertContainer(1, new LoroMap())
    deleted.set('id', 'saved-deleted')
    deleted.set('type', 'rectangle')
    deleted.set('isDeleted', true)
    doc.commit()
    await saveCanvas('session1', 'canvas-live-count', doc)

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlug: 'canvas-live-count', checkpointId: 'cp-save-live-count' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      checkpointId: 'cp-save-live-count',
      elementCount: 1,
    })
  })

  it('returns 404 when POST /api/workspaces/:workspaceId/checkpoints targets a missing sourceSlug', async () => {
    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlug: 'missing-canvas' }),
    })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({
      error: 'not_found',
    })
  })

  it('POST /api/canvas/:workspaceId/:slug/export-json writes an excalidraw export file', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'rect-1')
    map.set('type', 'rectangle')
    map.set('x', 10)
    map.set('y', 20)
    map.set('width', 100)
    map.set('height', 50)
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc)

    const app = createCanvasRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request('/api/canvas/session1/canvas-a/export-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeCustomFields: false }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string; elementCount: number }
    expect(body.filePath).toMatch(/\.excalidraw$/)
    expect(body.elementCount).toBe(1)
  })

  it('export-json writes to an explicit absolute outputPath when provided', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'rect-1')
    map.set('type', 'rectangle')
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc)

    const outputPath = join(tempDir, 'explicit', 'out.excalidraw')
    const app = createCanvasRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/export-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string; elementCount: number }
    expect(body.filePath).toBe(outputPath)
  })

  it('export-json rejects a relative outputPath with 400 invalid_output_path', async () => {
    const doc = new LoroDoc()
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc)

    const app = createCanvasRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/export-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: 'relative/out.excalidraw' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
  })

  it('export-json refuses to overwrite an existing file by default and returns 409', async () => {
    const doc = new LoroDoc()
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc)

    const outputPath = join(tempDir, 'existing.excalidraw')
    await writeFile(outputPath, 'OLD')

    const app = createCanvasRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/export-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: 'output_exists' })
  })

  it('export-json overwrites the existing file when overwrite=true', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'rect-1')
    map.set('type', 'rectangle')
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc)

    const outputPath = join(tempDir, 'replace-me.excalidraw')
    await writeFile(outputPath, 'OLD')

    const app = createCanvasRouter()
    const res = await app.request('/api/canvas/session1/canvas-a/export-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath, overwrite: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toBe(outputPath)
  })

  it('returns 400 for an invalid checkpointId', async () => {
    const app = createCanvasRouter()
    const res = await app.request('/api/workspaces/session1/checkpoints/bad.id/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSlug: 'canvas-a' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('createAutoVersionTrigger', () => {
  it('retries on the next edit without consuming the throttle window when save fails', async () => {
    const doc = new LoroDoc()
    const entry = {
      id: 'v1',
      slug: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
      hasThumbnail: false,
    }
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient fs error'))
      .mockResolvedValueOnce(entry)
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
      },
      30_000,
    )

    await expect(trigger('session1', 'canvas-a', doc)).resolves.toBeNull()
    await expect(trigger('session1', 'canvas-a', doc)).resolves.toEqual(entry)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('passes branchName to save when getHeadBranch is injected', async () => {
    const doc = new LoroDoc()
    const entry = {
      id: 'v1',
      slug: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
      hasThumbnail: false,
      branchName: 'feature',
    }
    const save = vi.fn().mockResolvedValue(entry)
    const getHeadBranch = vi
      .fn<(sid: string, slug: string) => Promise<string | null>>()
      .mockResolvedValue('feature')
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
      getHeadBranch,
    )

    await trigger('session1', 'canvas-a', doc)
    expect(getHeadBranch).toHaveBeenCalledWith('session1', 'canvas-a')
    expect(save).toHaveBeenCalledWith('session1', 'canvas-a', doc, {
      auto: true,
      branchName: 'feature',
      operator: {
        kind: 'system',
        peerId: doc.peerIdStr,
        displayName: 'auto-save',
      },
    })
  })

  it('calls save without branchName when getHeadBranch returns null', async () => {
    const doc = new LoroDoc()
    const save = vi.fn().mockResolvedValue({
      id: 'v1',
      slug: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
      hasThumbnail: false,
      branchName: 'main',
    })
    const getHeadBranch = vi.fn().mockResolvedValue(null)
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
      getHeadBranch,
    )
    await trigger('session1', 'canvas-a', doc)
    expect(save).toHaveBeenCalledWith('session1', 'canvas-a', doc, {
      auto: true,
      operator: {
        kind: 'system',
        peerId: doc.peerIdStr,
        displayName: 'auto-save',
      },
    })
  })

  it('does not silently fall back to save when getHeadBranch throws corruption', async () => {
    const doc = new LoroDoc()
    const save = vi.fn()
    const getHeadBranch = vi
      .fn<(sid: string, slug: string) => Promise<string | null>>()
      .mockRejectedValue(corruptStoredData('/tmp/branches.json', 'broken branch state'))
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
      getHeadBranch,
    )

    await expect(trigger('session1', 'canvas-a', doc)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken branch state'),
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('returns null without consuming the throttle window when versionStore.save throws corruption', async () => {
    const doc = new LoroDoc()
    const entry = {
      id: 'v2',
      slug: 'canvas-a',
      createdAt: '2026-04-23T00:00:00.000Z',
      elementCount: 0,
      auto: true,
      hasThumbnail: false,
      branchName: 'main',
    }
    const save = vi
      .fn()
      .mockRejectedValueOnce(corruptStoredData('/tmp/versions/v1.json', 'broken metadata'))
      .mockResolvedValueOnce(entry)
    const trigger = createAutoVersionTrigger(
      {
        save,
        load: vi.fn(),
        list: vi.fn(),
        saveThumbnail: vi.fn(),
        loadThumbnail: vi.fn(),
        earliestFrontiers: vi.fn(),
        getFrontiersBase64: vi.fn(),
        renameBranchInVersions: vi.fn(),
      },
      30_000,
    )

    await expect(trigger('session1', 'canvas-a', doc)).resolves.toBeNull()
    await expect(trigger('session1', 'canvas-a', doc)).resolves.toEqual(entry)
    expect(save).toHaveBeenCalledTimes(2)
  })
})

describe('auto-version corruption handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-routes-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    clearCache()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('returns 200 and skips version_created when auto-version save reports corruption', async () => {
    const wsModule = await import('./ws.js')
    const sendVersionCreated = vi
      .spyOn(wsModule, 'sendVersionCreated')
      .mockImplementation(() => undefined)
    const versionStore = {
      save: vi
        .fn()
        .mockRejectedValue(corruptStoredData('/tmp/versions/v1.json', 'broken metadata')),
      load: vi.fn(),
      list: vi.fn(),
      saveThumbnail: vi.fn(),
      loadThumbnail: vi.fn(),
      earliestFrontiers: vi.fn(),
      getFrontiersBase64: vi.fn(),
      renameBranchInVersions: vi.fn(),
    }

    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const map = list.insertContainer(0, new LoroMap())
    map.set('id', 'e1')
    map.set('type', 'rectangle')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    const app = createCanvasRouter({
      autoVersionIntervalMs: 0,
      versionStore,
    })
    const res = await app.request('/api/canvas/session1/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })

    expect(res.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(versionStore.save).toHaveBeenCalledTimes(1)
    expect(sendVersionCreated).not.toHaveBeenCalled()

    clearCache()
    const { loadCanvas } = await import('../store/canvas-store.js')
    const serverDoc = await loadCanvas('session1', 'canvas-a')
    const elements = serverDoc.getMovableList('elements').toJSON() as Array<{ id: string }>
    expect(elements.map((entry) => entry.id)).toEqual(['e1'])
  })
})
