import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-maintenance-test-')

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

describe('POST /api/workspaces/:workspaceId/documents/:path/compact', () => {
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
      pruneSandwichedAutoVersions: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [] }),
    }
  }

  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  })

  it('returns structured 500 for a broken snapshot', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const db = await getDb(tmp.dir)
    const row = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'canvas-a')
      .executeTakeFirstOrThrow()
    const blobPath = join(tmp.dir, 'blobs', 'session1', 'document', `${row.id}.loro`)
    await writeFile(blobPath, Buffer.from('not-a-loro-snapshot'))

    const app = createDocumentRouter({ versionStore: createVersionStoreMock() })
    const res = await app.request('/api/workspaces/session1/documents/canvas-a/compact', {
      method: 'POST',
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining(`${row.id}.loro`),
    })
  })

  // Canvas blobs live under blobs/{workspaceId}/document/, so the previous
  // "non-directory session path" stat failure case no longer maps. compact
  // returns no-file for missing blobs, and the corrupt-snapshot case above
  // still exercises the corruption branch.
})

describe('POST /api/workspaces/:workspaceId/documents/optimize-all', () => {
  function createVersionStoreMock() {
    return {
      save: vi.fn(),
      load: vi.fn(),
      list: vi.fn(),
      saveThumbnail: vi.fn(),
      loadThumbnail: vi.fn(),
      // No version cut available — each per-canvas compact returns
      // reason: 'no-versions'. That is the realistic dry-run shape; what
      // matters is the bulk endpoint loops every canvas and aggregates
      // totals correctly.
      earliestFrontiers: vi.fn().mockResolvedValue(null),
      getFrontiersBase64: vi.fn(),
      renameBranchInVersions: vi.fn(),
      // The bulk-optimize route doesn't exercise prune by default, but the
      // VersionStore contract requires it. Returning a no-op result keeps
      // the mock fully type-compatible so a future route change that does
      // call this method here cannot trip on a missing key.
      pruneSandwichedAutoVersions: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [] }),
    }
  }

  it('iterates every canvas in the workspace and returns aggregated results', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    await saveDocument('session1', 'canvas-b', new LoroDoc())

    const app = createDocumentRouter({ versionStore: createVersionStoreMock() })
    const res = await app.request('/api/workspaces/session1/documents/optimize-all', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      results: Array<{
        path: string
        compacted: boolean
        beforeBytes: number
        afterBytes: number
        reason?: string
      }>
      totalBeforeBytes: number
      totalAfterBytes: number
    }
    expect(json.results.map((r) => r.path).sort()).toEqual(['canvas-a', 'canvas-b'])
    expect(json.results.every((r) => r.compacted === false)).toBe(true)
    expect(json.results.every((r) => r.reason === 'no-versions')).toBe(true)
    expect(json.totalBeforeBytes).toBeGreaterThan(0)
    expect(json.totalAfterBytes).toBe(json.totalBeforeBytes)
  })

  it('returns an empty result set when the workspace has no documents', async () => {
    const app = createDocumentRouter({ versionStore: createVersionStoreMock() })
    const res = await app.request('/api/workspaces/session1/documents/optimize-all', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      results: unknown[]
      totalBeforeBytes: number
      totalAfterBytes: number
    }
    expect(json.results).toEqual([])
    expect(json.totalBeforeBytes).toBe(0)
    expect(json.totalAfterBytes).toBe(0)
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

    const app = createDocumentRouter({ versionStore })
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
