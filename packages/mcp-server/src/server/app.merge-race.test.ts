import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeFrontiers, LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-merge-race-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

vi.mock('../daemon/ensure-daemon.js', () => ({
  ensureDaemon: vi.fn(async () => ({
    pid: 1,
    port: 3099,
    token: 'secret',
    version: '0.1.0',
    startedAt: '2026-04-24T00:00:00.000Z',
    baseUrl: 'http://daemon.test',
  })),
}))

// Mock doc-cache so getDoc can be gated to control interleaving against a
// concurrent rename, mirroring canvas/workspaces.test.ts's phantom-duplicate pin.
vi.mock('./store/doc-cache.js', async () => {
  const actual =
    await vi.importActual<typeof import('./store/doc-cache.js')>('./store/doc-cache.js')
  return { ...actual, getDoc: vi.fn(actual.getDoc) }
})

const { createApp } = await import('./app.js')
const { clearCache, getDoc } = await import('./store/doc-cache.js')
const { clearWorkspaceIdCache } = await import('./mcp/session-resolver.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')
const { saveDocument } = await import('./store/document-store.js')
const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')

function createRuntimeOptions() {
  return {
    authMode: 'local-daemon' as const,
    token: undefined,
    mcpAuth: undefined,
    touch: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    getStatus: () => ({
      ok: true,
      pid: 10,
      host: '127.0.0.1',
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      version: PACKAGE_VERSION,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 10,
      auth: { mode: 'local-token' as const, hasToken: false },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' as const },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  }
}

describe('performMerge vs rename race', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
    await writeFile(
      join(tmp.dir, 'web-app', 'index.html'),
      '<!DOCTYPE html><html><head><title>Whiteboard</title></head><body><div id="root"></div></body></html>',
    )
    clearCache()
    clearWorkspaceIdCache()
  })

  afterEach(async () => {
    await rm(tmp.dir, { recursive: true, force: true })
    clearCache()
  })

  it('does not fork a phantom duplicate canvas when a path rename races an in-flight merge that already resolved the live doc through the old path', async () => {
    const app = createApp(createRuntimeOptions())

    // Base canvas: rect-1 only.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const el1 = list.insertContainer(0, new LoroMap())
    el1.set('id', 'rect-1')
    doc.commit()
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

    // feature's tip freezes the rect-1-only state.
    const featureTipFrontiers = Buffer.from(encodeFrontiers(doc.frontiers())).toString('base64')

    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const state = await loadCanvasBranches('session1', 'canvas-a')
    const feature = state.branches.find((b) => b.name === 'feature')!
    feature.tipFrontiers = featureTipFrontiers
    await saveCanvasBranches('session1', 'canvas-a', state)

    // Add rect-2 directly on top so main's empty tip (== "current live doc")
    // diverges from feature's frozen rect-1-only tip. Merging feature into
    // main (source wins) will reconcile the live doc back down to rect-1
    // and persist it, exercising performMerge's getDoc -> saveDocument span.
    const el2 = list.insertContainer(1, new LoroMap())
    el2.set('id', 'rect-2')
    doc.commit()
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

    // Stall performMerge's getDoc() call so a path rename can be fired
    // while the merge request is paused mid-flight, matching the real
    // race: the read resolves before the rename runs, the write happens
    // after.
    const { promise: getDocGate, resolve: releaseGetDoc } = Promise.withResolvers<void>()
    const { promise: getDocCalled, resolve: signalGetDocCalled } = Promise.withResolvers<void>()
    const actual =
      await vi.importActual<typeof import('./store/doc-cache.js')>('./store/doc-cache.js')
    vi.mocked(getDoc).mockImplementationOnce(async (workspaceId, path) => {
      signalGetDocCalled()
      await getDocGate
      return actual.getDoc(workspaceId, path)
    })

    const mergePromise = app.request(
      '/api/workspaces/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main' }),
      },
    )

    await getDocCalled

    // Fire the rename while the merge is stalled mid-flight.
    const renamePromise = app.request('/api/workspaces/session1/canvases/canvas-a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'canvas-b' }),
    })
    // Give the rename a chance to run before letting the stalled read continue.
    await new Promise((r) => setTimeout(r, 20))
    releaseGetDoc()

    const [mergeRes, renameRes] = await Promise.all([mergePromise, renamePromise])
    expect(renameRes.status).toBe(200)
    expect(mergeRes.status).toBe(200)

    // Exactly one canvas must survive -- at the post-rename path. The merge
    // must not have silently inserted a phantom duplicate back at the old
    // path.
    const listRes = await app.request('/api/workspaces/session1/canvases')
    const listJson = (await listRes.json()) as { canvases: { path: string }[] }
    expect(listJson.canvases.map((c) => c.path)).toEqual(['canvas-b'])
  })
})
