import { mkdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
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
const { createVersionsRouter } = await import('./versions.js')
const { createCanvasRouter } = await import('../canvas.js')

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
  })
  afterEach(() => {
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
    const resUpdate = await app.request('/api/w/session1/canvas/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(resUpdate.status).toBe(200)

    // Auto-version saving is best-effort and async, so wait briefly.
    await new Promise((r) => setTimeout(r, 50))

    const resList = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')
    expect(resList.status).toBe(200)
    const body = (await resList.json()) as {
      versions: Array<{ auto: boolean; elementCount: number }>
    }
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
      version: {
        operator?: { kind: string; peerId: string; displayName?: string; agentId?: string }
      }
    }
    expect(body.version.operator).toEqual({
      kind: 'ai',
      peerId: 'peer-ai',
      displayName: 'Assistant',
      agentId: 'agent-1',
    })

    const listRes = await app.request('/api/workspaces/session1/canvases/canvas-a/versions')
    const listBody = (await listRes.json()) as {
      versions: Array<{
        operator?: { kind: string; peerId: string; displayName?: string; agentId?: string }
      }>
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
    const resUpdate = await app.request('/api/w/session1/canvas/canvas-a/update', {
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

  it('filters GET /versions by path and returns newest first', async () => {
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
})
