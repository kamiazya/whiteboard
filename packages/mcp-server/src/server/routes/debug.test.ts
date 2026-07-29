import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearCache, getDoc } = await import('../store/doc-cache.js')
const { saveCanvas } = await import('../store/canvas-store.js')
const { createDebugRouter } = await import('./debug.js')

function makeDocWithElements(visible: number, tombstones: number): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  for (let i = 0; i < visible; i++) {
    const map = list.insertContainer(list.length, new LoroMap())
    map.set('id', `vis-${i}`)
    map.set('type', 'rectangle')
  }
  for (let i = 0; i < tombstones; i++) {
    const map = list.insertContainer(list.length, new LoroMap())
    map.set('id', `dead-${i}`)
    map.set('type', 'rectangle')
    map.set('isDeleted', true)
  }
  doc.commit()
  return doc
}

describe('GET /api/debug', () => {
  const originalDebugEnv = process.env.WHITEBOARD_DEBUG

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-debug-test-'))
    clearCache()
    process.env.WHITEBOARD_DEBUG = '1'
  })

  afterEach(async () => {
    if (originalDebugEnv === undefined) {
      delete process.env.WHITEBOARD_DEBUG
    } else {
      process.env.WHITEBOARD_DEBUG = originalDebugEnv
    }
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('returns session and canvas element counts for visible and tombstoned elements', async () => {
    await mkdir(join(tempDir, 'sess-a'), { recursive: true })
    await saveCanvas('sess-a', 'canvas-1', makeDocWithElements(3, 2))
    await saveCanvas('sess-a', 'canvas-2', makeDocWithElements(1, 0))

    const app = createDebugRouter()
    const res = await app.request('/api/debug')
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      workspaces: Array<{
        workspaceId: string
        canvases: Array<{
          slug: string
          totalElements: number
          visibleElements: number
          tombstones: number
          cached: boolean
        }>
      }>
      cache: { size: number; keys: string[] }
    }

    const session = json.workspaces.find((s) => s.workspaceId === 'sess-a')
    expect(session).toBeDefined()
    const c1 = session!.canvases.find((c) => c.slug === 'canvas-1')
    const c2 = session!.canvases.find((c) => c.slug === 'canvas-2')
    expect(c1).toEqual(
      expect.objectContaining({
        slug: 'canvas-1',
        totalElements: 5,
        visibleElements: 3,
        tombstones: 2,
      }),
    )
    expect(c2).toEqual(
      expect.objectContaining({
        slug: 'canvas-2',
        totalElements: 1,
        visibleElements: 1,
        tombstones: 0,
      }),
    )
  })

  it('marks only canvases touched through getDoc as cached in the cache section', async () => {
    await mkdir(join(tempDir, 'sess-cache'), { recursive: true })
    await saveCanvas('sess-cache', 'touched', makeDocWithElements(1, 0))
    await saveCanvas('sess-cache', 'untouched', makeDocWithElements(1, 0))

    // Only touched canvases should appear in cache.
    await getDoc('sess-cache', 'touched')

    const app = createDebugRouter()
    const res = await app.request('/api/debug')
    const json = (await res.json()) as {
      workspaces: Array<{ workspaceId: string; canvases: Array<{ slug: string; cached: boolean }> }>
      cache: { size: number; keys: string[] }
    }

    expect(json.cache.keys).toContain('sess-cache/touched')
    expect(json.cache.keys).not.toContain('sess-cache/untouched')

    const session = json.workspaces.find((s) => s.workspaceId === 'sess-cache')!
    expect(session.canvases.find((c) => c.slug === 'touched')?.cached).toBe(true)
    expect(session.canvases.find((c) => c.slug === 'untouched')?.cached).toBe(false)
  })

  it('returns workspaces: [] when no sessions exist', async () => {
    const app = createDebugRouter()
    const res = await app.request('/api/debug')
    const json = (await res.json()) as { workspaces: unknown[] }
    expect(json.workspaces).toEqual([])
  })

  it('requires bearer auth when a daemon token is configured', async () => {
    process.env.WHITEBOARD_DEBUG = '1'
    const app = createDebugRouter({ token: 'secret' })

    const unauthenticated = await app.request('/api/debug')
    expect(unauthenticated.status).toBe(401)
    await expect(unauthenticated.json()).resolves.toEqual({ error: 'unauthorized' })

    const authenticated = await app.request('/api/debug', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(authenticated.status).toBe(200)
  })

  it('remains public when no daemon token is configured', async () => {
    process.env.WHITEBOARD_DEBUG = '1'
    const app = createDebugRouter()
    const res = await app.request('/api/debug')
    expect(res.status).toBe(200)
  })

  it('returns 404 unless WHITEBOARD_DEBUG=1 is enabled', async () => {
    delete process.env.WHITEBOARD_DEBUG
    const app = createDebugRouter({ token: 'secret' })

    const res = await app.request('/api/debug', {
      headers: { Authorization: 'Bearer secret' },
    })

    expect(res.status).toBe(404)
  })
})
