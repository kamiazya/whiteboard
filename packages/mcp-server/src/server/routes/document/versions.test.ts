import { mkdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-versions-test-')

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
const { createVersionsRouter } = await import('./versions.js')
const { createDocumentRouter } = await import('../document.js')

// A real published did:key — what a daemon's identity answers with. The
// value is opaque to this route; what matters is that the route stamps the
// one it was given rather than minting something per call.
const TEST_DAEMON_ACTOR = 'did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP'

// A different real did:key — what a caller would put there to claim it was
// some other device, or this daemon's own.
const SOMEONE_ELSES_ACTOR = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

describe('versions router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createVersionsRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})

// Version API coverage: auto-save on update, list, manual save, and operator stamping.
describe('versions API', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
    clearCache()
    _clearWorkspaceDocCacheForTests()
    // Version save refuses a path with no document; seed the canvases the
    // routes below checkpoint — the shape production always has.
    await saveDocument('session1', 'canvas-a', new LoroDoc(), { kind: 'spatial' })
    await saveDocument('session1', 'canvas-b', new LoroDoc(), { kind: 'spatial' })
  })
  afterEach(() => {
    clearCache()
  })

  it('saves an auto-version immediately when autoVersionQuietMs=0', async () => {
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const m = list.insertContainer(0, new LoroMap())
    m.set('id', 'e1')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    const app = createDocumentRouter({ autoVersionQuietMs: 0 })
    const resUpdate = await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(resUpdate.status).toBe(200)

    // Auto-version saving is best-effort and async, so wait briefly.
    await new Promise((r) => setTimeout(r, 50))

    const resList = await app.request('/api/workspaces/session1/documents/canvas-a/versions')
    expect(resList.status).toBe(200)
    const body = (await resList.json()) as {
      versions: Array<{ auto: boolean; elementCount: number }>
    }
    expect(body.versions.length).toBeGreaterThanOrEqual(1)
    expect(body.versions[0].auto).toBe(true)
    expect(body.versions[0].elementCount).toBe(1)
  })

  it('saves a manual version with a label through POST /versions', async () => {
    const app = createDocumentRouter({ autoVersionQuietMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
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
    const app = createDocumentRouter({
      autoVersionQuietMs: 60_000,
      daemonActor: TEST_DAEMON_ACTOR,
    })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'ai save',
        operator: { kind: 'ai', displayName: 'Assistant', agentId: 'agent-1' },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: {
        operator?: { kind: string; actor?: string; displayName?: string; agentId?: string }
      }
    }
    // Everything the caller stated, plus the device it does not get to name.
    expect(body.version.operator).toEqual({
      kind: 'ai',
      displayName: 'Assistant',
      agentId: 'agent-1',
      actor: TEST_DAEMON_ACTOR,
    })

    const listRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions')
    const listBody = (await listRes.json()) as {
      versions: Array<{
        operator?: { kind: string; actor?: string; displayName?: string; agentId?: string }
      }>
    }
    expect(listBody.versions[0]?.operator).toEqual(body.version.operator)
  })

  it('POST /versions defaults operator to human when omitted', async () => {
    const app = createDocumentRouter({ autoVersionQuietMs: 60_000 })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'manual save' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: { operator?: { kind: string; actor?: string; displayName?: string } }
    }
    expect(body.version.operator?.kind).toBe('human')
    // No daemonActor was given to this composition, so the row names no
    // actor. `toMatch(/\S+/)` stood here and passed over a fresh Loro peer
    // id every time — an assertion that the field was non-blank could not
    // tell an identity from a random number.
    expect(body.version.operator?.actor).toBeUndefined()
    expect(body.version.operator?.displayName).toBe(userInfo().username)
  })

  // The operator's `actor` is the one thing in a version row that has to
  // survive the daemon restarting — it is the record of WHO saved this, and
  // a value that changes on its own says nothing. Loro mints a fresh peer id
  // on every load of the same document (measured: three loads, three
  // numbers), so stamping one here recorded noise as identity, and a test
  // asserting only that the field was non-blank passed over it.
  it('POST /versions stamps the daemon actor, unchanged across a document reload', async () => {
    const app = createDocumentRouter({
      autoVersionQuietMs: 60_000,
      daemonActor: TEST_DAEMON_ACTOR,
    })
    const save = async () => {
      const res = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = (await res.json()) as { version: { operator?: { actor?: string } } }
      return body.version.operator
    }

    const first = await save()
    // Drop the cached LoroDoc so the second save reads the document back off
    // disk — the state a restarted daemon is always in.
    clearCache()
    _clearWorkspaceDocCacheForTests()
    const second = await save()

    expect(first?.actor).toBe(TEST_DAEMON_ACTOR)
    expect(second?.actor).toBe(TEST_DAEMON_ACTOR)
  })

  // `actor` is the DEVICE that saved the row, and the daemon is the only
  // party that can ever back it with a key (ADR-0035 decision 2). Accepting
  // one from the request made it a self-report wearing a cryptographic
  // shape: anything holding `workspace:write` could write a row claiming to
  // be this daemon, or any other device.
  it('refuses an operator that names a device, rather than believing the caller', async () => {
    const app = createDocumentRouter({
      autoVersionQuietMs: 60_000,
      daemonActor: TEST_DAEMON_ACTOR,
    })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator: { kind: 'human', actor: SOMEONE_ELSES_ACTOR, displayName: 'Mallory' },
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_body')
    expect(body.message).toMatch(/actor/)
  })

  // The half a caller legitimately knows and the daemon does not: which KIND
  // of party asked, and what to show a reader. Those stay a self-report, as
  // they always were.
  it('keeps the caller\u2019s kind and display name, and stamps its own device', async () => {
    const app = createDocumentRouter({
      autoVersionQuietMs: 60_000,
      daemonActor: TEST_DAEMON_ACTOR,
    })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator: { kind: 'ai', displayName: 'Assistant' } }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: { operator?: { kind: string; actor?: string; displayName?: string } }
    }
    expect(body.version.operator).toEqual({
      kind: 'ai',
      displayName: 'Assistant',
      actor: TEST_DAEMON_ACTOR,
    })
  })

  it('POST /update auto-version persists system/auto-save operator', async () => {
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const m = list.insertContainer(0, new LoroMap())
    m.set('id', 'e-auto')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })

    const app = createDocumentRouter({ autoVersionQuietMs: 0 })
    const resUpdate = await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(resUpdate.status).toBe(200)

    await new Promise((r) => setTimeout(r, 50))

    const resList = await app.request('/api/workspaces/session1/documents/canvas-a/versions')
    const body = (await resList.json()) as {
      versions: Array<{ operator?: { kind: string; actor?: string; displayName?: string } }>
    }
    expect(body.versions[0]?.operator).toMatchObject({
      kind: 'system',
      displayName: 'auto-save',
    })
    expect(body.versions[0]?.operator?.actor).toBeUndefined()
  })

  it('filters GET /versions by path and returns newest first', async () => {
    const app = createDocumentRouter({ autoVersionQuietMs: 60_000 })
    await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      body: JSON.stringify({ label: 'a1' }),
      headers: { 'Content-Type': 'application/json' },
    })
    await app.request('/api/workspaces/session1/documents/canvas-b/versions', {
      method: 'POST',
      body: JSON.stringify({ label: 'b1' }),
      headers: { 'Content-Type': 'application/json' },
    })

    const resA = await app.request('/api/workspaces/session1/documents/canvas-a/versions')
    const bodyA = (await resA.json()) as { versions: Array<{ label?: string }> }
    expect(bodyA.versions.map((v) => v.label)).toEqual(['a1'])

    const resB = await app.request('/api/workspaces/session1/documents/canvas-b/versions')
    const bodyB = (await resB.json()) as { versions: Array<{ label?: string }> }
    expect(bodyB.versions.map((v) => v.label)).toEqual(['b1'])
  })
})

// Reading a past state, which is what makes "see it, then decide" possible.
// The panel used to offer restore behind a confirmation and nothing else, so
// the only way to learn what a version held was to apply it and look.
describe('GET /versions/:id/document', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
    clearCache()
    _clearWorkspaceDocCacheForTests()
    await saveDocument('session1', 'canvas-a', new LoroDoc(), { kind: 'spatial' })
    await saveDocument('session1', 'canvas-b', new LoroDoc(), { kind: 'spatial' })
  })
  afterEach(() => {
    clearCache()
  })

  it('answers the canvas as it stood, not as it stands', async () => {
    const app = createDocumentRouter({ autoVersionQuietMs: 60_000 })

    const first = new LoroDoc()
    writeSpatialCanvas(first, {
      nodes: [{ id: 'kept', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'kept' }],
      edges: [],
    })
    first.commit()
    await saveDocument('session1', 'canvas-a', first, { kind: 'spatial', overwrite: true })

    const saved = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'before' }),
    })
    expect(saved.status).toBe(200)
    const { version } = (await saved.json()) as { version: { id: string } }

    // Move on, so a stale read would answer the CURRENT state instead.
    const second = new LoroDoc()
    second.import(first.export({ mode: 'snapshot' }))
    writeSpatialCanvas(second, {
      nodes: [
        { id: 'kept', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'kept' },
        { id: 'added-later', type: 'text', x: 90, y: 0, width: 80, height: 40, text: 'later' },
      ],
      edges: [],
    })
    second.commit()
    await saveDocument('session1', 'canvas-a', second, { kind: 'spatial', overwrite: true })

    const res = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${version.id}/document`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kind: string; canvas: { nodes: { id: string }[] } }
    expect(body.kind).toBe('spatial')
    expect(body.canvas.nodes.map((n) => n.id)).toEqual(['kept'])
  })

  it('refuses a version id that belongs to another document, as restore does', async () => {
    const app = createDocumentRouter({ autoVersionQuietMs: 60_000 })
    const saved = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'a' }),
    })
    const { version } = (await saved.json()) as { version: { id: string } }

    // The id alone would otherwise read one document's history through
    // another's path.
    const res = await app.request(
      `/api/workspaces/session1/documents/canvas-b/versions/${version.id}/document`,
    )
    expect(res.status).toBe(404)
  })
})
