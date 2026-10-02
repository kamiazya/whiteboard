import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { compactWorkspaceResultSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { versionStoreMock } from '../../store/test-utils/version-store-mock.js'
import { resolveTestServerDeps, testDataLayout, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-maintenance-test-')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir (routers no longer compose their own).
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

const { clearCache } = await import('../../store/doc-cache.js')
const { getDb } = await import('../../store/db/index.js')
const { saveDocument } = await import('../../store/document-store.js')
const { createMaintenanceRouter } = await import('./maintenance.js')
const { createDocumentRouter } = await import('../document.js')

beforeEach(() => {
  clearCache()
})
afterEach(() => {
  clearCache()
})

describe('maintenance router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createMaintenanceRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})

describe('POST /api/workspaces/:workspaceId/documents/optimize-all (corrupt record)', () => {
  const createVersionStoreMock = () =>
    versionStoreMock({ earliestWorkspaceFrontiers: vi.fn().mockResolvedValue([]) })

  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  })

  it('returns structured 500 for a broken snapshot', async () => {
    const { LibsqlDocumentStore } = await import('../../store/libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')

    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const db = await getDb(tmp.dir)
    // Corrupt the WORKSPACE record's snapshot rows directly — that is where
    // content lives — and drop the live cache so the compact actually reads
    // the stored bytes.
    const libsqlStore = new LibsqlDocumentStore(db)
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await libsqlStore.saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: 'session1' },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })
    const { _clearWorkspaceDocCacheForTests } = await import('../../store/document-store.js')
    _clearWorkspaceDocCacheForTests()

    const app = createDocumentRouter({
      dataLayout: testDataLayout(),
      serverDeps,
      versionStore: createVersionStoreMock(),
    })
    const res = await app.request('/api/workspaces/session1/documents/optimize-all', {
      method: 'POST',
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('workspace-tree:session1'),
    })
  })
})

describe('POST /api/workspaces/:workspaceId/documents/optimize-all', () => {
  // No version cut available — the fold answers reason: 'no-versions', the
  // realistic dry-run shape, which is the mock's default.
  const createVersionStoreMock = () => versionStoreMock()

  // Every document lives in the one workspace record, so the route folds it
  // ONCE and answers with that fold — not with a per-document list that
  // compacted the same record N times, the first for real and the rest to
  // find out there was no gain.
  it('compacts the workspace record once, however many documents it holds', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    await saveDocument('session1', 'canvas-b', new LoroDoc())

    const versionStore = createVersionStoreMock()
    const app = createDocumentRouter({ dataLayout: testDataLayout(), serverDeps, versionStore })
    const res = await app.request('/api/workspaces/session1/documents/optimize-all', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const json = compactWorkspaceResultSchema.parse(await res.json())
    expect(json.compacted).toBe(false)
    expect(json.reason).toBe('no-versions')
    expect(json.beforeBytes).toBeGreaterThan(0)
    expect(json.afterBytes).toBe(json.beforeBytes)
    // One fold: the cut is looked up once per compaction.
    expect(versionStore.earliestWorkspaceFrontiers).toHaveBeenCalledTimes(1)
  })

  it('answers no-file for a workspace with nothing stored', async () => {
    const app = createDocumentRouter({
      dataLayout: testDataLayout(),
      serverDeps,
      versionStore: createVersionStoreMock(),
    })
    const res = await app.request('/api/workspaces/session1/documents/optimize-all', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(compactWorkspaceResultSchema.parse(await res.json())).toEqual({
      compacted: false,
      beforeBytes: 0,
      afterBytes: 0,
      reason: 'no-file',
    })
  })

  it('prune-sandwiched delegates to versionStore.pruneSandwichedAutoVersions for every canvas', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    await saveDocument('session1', 'canvas-b', new LoroDoc())

    const versionStore = createVersionStoreMock()
    versionStore.pruneSandwichedAutoVersions = vi
      .fn()
      .mockImplementation(async (_wid: string, path: string) => ({
        deletedCount: path === 'canvas-a' ? 2 : 1,
        deletedIds: path === 'canvas-a' ? ['x', 'y'] : ['z'],
      }))

    const app = createDocumentRouter({ dataLayout: testDataLayout(), serverDeps, versionStore })
    const res = await app.request('/api/workspaces/session1/versions/prune-sandwiched', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      results: Array<{ path: string; deletedCount: number }>
      totalDeleted: number
    }
    expect(json.totalDeleted).toBe(3)
    expect(json.results.map((r) => r.path).sort()).toEqual(['canvas-a', 'canvas-b'])
    expect(versionStore.pruneSandwichedAutoVersions).toHaveBeenCalledTimes(2)
  })
})
