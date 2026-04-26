import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const { createBranchesRouter } = await import('./branches.js')
const { corruptStoredData } = await import('../store/corrupt-stored-data.js')

type PerformMergeFn = (
  sid: string,
  slug: string,
  args: { source: string; into: string; dryRun: boolean },
) => Promise<{
  previewElementCount: number
  badges: Array<Record<string, unknown>>
  committed: boolean
}>

type RenameInVersionsFn = (
  sid: string,
  slug: string,
  oldName: string,
  newName: string,
) => Promise<number>

function makeApp(
  opts: {
    resolveFromVersionFrontiers?: (sid: string, id: string) => Promise<string | null>
    getCurrentFrontiers?: (sid: string, slug: string) => Promise<string | null>
    checkoutTo?: (sid: string, slug: string, tipFrontiersBase64: string) => Promise<void>
    notifyHeadChanged?: (sid: string, slug: string, head: string) => void
    performMerge?: PerformMergeFn
    renameInVersions?: RenameInVersionsFn
    countVersionsOnBranch?: (sid: string, slug: string, branch: string) => Promise<number>
  } = {},
) {
  const app = new Hono()
  app.route('/', createBranchesRouter(opts))
  return app
}

describe('POST /api/workspaces/:sid/canvases/:slug/branches', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'branches-route-test-'))
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates a new branch and returns 201 with the branch', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature-x', color: '#9333ea' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { branch: { name: string; color: string } }
    expect(body.branch.name).toBe('feature-x')
    expect(body.branch.color).toBe('#9333ea')
  })

  it('returns 409 for duplicate names', async () => {
    const app = makeApp()
    // main already exists through the lazy default state, so creating it returns 409.
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'main' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('branch_conflict')
    expect(body.message).toMatch(/already exists/i)
  })

  it('returns 400 for an invalid name', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a/b' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_branch_name',
      message: 'Invalid branch name "a/b": "/" is not allowed',
    })
  })

  it('returns structured 400 responses for invalid sid and slug', async () => {
    const app = makeApp()

    const badSession = await app.request('/api/workspaces/bad.sid/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature-x' }),
    })
    expect(badSession.status).toBe(400)
    await expect(badSession.json()).resolves.toEqual({
      error: 'invalid_workspace_id',
      message: 'Invalid workspaceId "bad.sid": only ASCII letters, digits, "_" and "-" are allowed',
    })

    const badSlug = await app.request('/api/workspaces/s1/canvases/bad.slug/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature-x' }),
    })
    expect(badSlug.status).toBe(400)
    await expect(badSlug.json()).resolves.toEqual({
      error: 'invalid_slug',
      message:
        'Invalid slug "bad.slug": segment "bad.slug" contains \'.\' (only letters, digits, and \'-\' are allowed)',
    })
  })

  it('initializes tipFrontiers through the injected resolver when fromVersionId is provided', async () => {
    const resolve = vi
      .fn<(sid: string, id: string) => Promise<string | null>>()
      .mockResolvedValue('AAECAw==')
    const app = makeApp({ resolveFromVersionFrontiers: resolve })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'from-v1', fromVersionId: 'v-abc' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      branch: { tipFrontiers: string; baseVersionId?: string }
    }
    expect(body.branch.tipFrontiers).toBe('AAECAw==')
    expect(body.branch.baseVersionId).toBe('v-abc')
    expect(resolve).toHaveBeenCalledWith('s1', 'v-abc')
  })

  it('returns 404 when fromVersionId is not found', async () => {
    const app = makeApp({
      resolveFromVersionFrontiers: vi.fn().mockResolvedValue(null),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', fromVersionId: 'ghost' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns structured 400 for an invalid fromVersionId', async () => {
    const app = makeApp({
      resolveFromVersionFrontiers: vi.fn().mockResolvedValue('AAECAw=='),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'from-v1', fromVersionId: 'bad.id' }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_version_id',
      message: 'Invalid version id "bad.id": must match /^[a-zA-Z0-9_-]+$/',
    })
  })

  it('returns unsupported_from_version when the deployment does not support fromVersionId', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'from-v1', fromVersionId: 'v-abc' }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'unsupported_from_version',
      message: 'fromVersionId is not supported in this deployment',
    })
  })
})

describe('GET /api/workspaces/:sid/canvases/:slug/branches', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'branches-route-test-'))
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns main as the only branch with head="main" in the initial lazy-default state', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      branches: Array<{ name: string }>
      head: string
    }
    expect(body.head).toBe('main')
    expect(body.branches.map((b) => b.name)).toEqual(['main'])
  })

  it('returns structured 400 responses for invalid sid and slug', async () => {
    const app = makeApp()

    const badSession = await app.request('/api/workspaces/bad.sid/canvases/canvas-a/branches')
    expect(badSession.status).toBe(400)
    await expect(badSession.json()).resolves.toEqual({
      error: 'invalid_workspace_id',
      message: 'Invalid workspaceId "bad.sid": only ASCII letters, digits, "_" and "-" are allowed',
    })

    const badSlug = await app.request('/api/workspaces/s1/canvases/bad.slug/branches')
    expect(badSlug.status).toBe(400)
    await expect(badSlug.json()).resolves.toEqual({
      error: 'invalid_slug',
      message:
        'Invalid slug "bad.slug": segment "bad.slug" contains \'.\' (only letters, digits, and \'-\' are allowed)',
    })
  })
})

describe('GET /api/workspaces/:sid/canvases/:slug/branches/:name/stats', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'branches-route-test-'))
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns unmergedCommits from the injected countVersionsOnBranch', async () => {
    const countVersionsOnBranch = vi
      .fn<(sid: string, slug: string, branch: string) => Promise<number>>()
      .mockResolvedValue(7)
    const app = makeApp({ countVersionsOnBranch })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature/stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { unmergedCommits: number; isHead: boolean }
    expect(body.unmergedCommits).toBe(7)
    expect(body.isHead).toBe(false)
    expect(countVersionsOnBranch).toHaveBeenCalledWith('s1', 'canvas-a', 'feature')
  })

  it('returns isHead=true for the HEAD branch stats', async () => {
    const app = makeApp({
      countVersionsOnBranch: vi.fn().mockResolvedValue(3),
    })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature/stats')
    const body = (await res.json()) as { unmergedCommits: number; isHead: boolean }
    expect(body.isHead).toBe(true)
  })

  it('returns 404 for a missing branch', async () => {
    const app = makeApp({
      countVersionsOnBranch: vi.fn().mockResolvedValue(0),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/ghost/stats')
    expect(res.status).toBe(404)
  })

  it('returns structured 500 instead of 200 + 0 when countVersionsOnBranch reports corruption', async () => {
    const app = makeApp({
      countVersionsOnBranch: vi
        .fn<(sid: string, slug: string, branch: string) => Promise<number>>()
        .mockRejectedValue(corruptStoredData('/tmp/versions', 'broken version metadata')),
    })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature/stats')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken version metadata'),
    })
  })
})

describe('DELETE /api/workspaces/:sid/canvases/:slug/branches/:name', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'branches-route-test-'))
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('deletes an existing non-HEAD branch with 200', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; unmergedCommits: number }
    expect(body.ok).toBe(true)
    expect(typeof body.unmergedCommits).toBe('number')
  })

  it('returns a real unmergedCommits count when countVersionsOnBranch is injected', async () => {
    const countVersionsOnBranch = vi
      .fn<(sid: string, slug: string, branch: string) => Promise<number>>()
      .mockResolvedValue(3)
    const app = makeApp({ countVersionsOnBranch })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; unmergedCommits: number }
    expect(body.unmergedCommits).toBe(3)
    expect(countVersionsOnBranch).toHaveBeenCalledWith('s1', 'canvas-a', 'feature')
  })

  it('returns unmergedCommits=0 when countVersionsOnBranch is not injected', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'DELETE',
    })
    const body = (await res.json()) as { unmergedCommits: number }
    expect(body.unmergedCommits).toBe(0)
  })

  it('returns 500 and keeps the branch when countVersionsOnBranch reports corruption after delete', async () => {
    const app = makeApp({
      countVersionsOnBranch: vi
        .fn<(sid: string, slug: string, branch: string) => Promise<number>>()
        .mockRejectedValue(corruptStoredData('/tmp/versions', 'broken version metadata')),
    })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'DELETE',
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken version metadata'),
    })

    const branchesRes = await app.request('/api/workspaces/s1/canvases/canvas-a/branches')
    const body = (await branchesRes.json()) as { branches: Array<{ name: string }> }
    expect(body.branches.map((branch) => branch.name)).toContain('feature')
  })

  it('returns 409 when deleting main', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/main', {
      method: 'DELETE',
    })
    expect(res.status).toBe(409)
  })

  it('returns 409 when deleting the HEAD branch', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'DELETE',
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: 'branch_conflict',
      message: 'Cannot delete branch "feature" while it is HEAD. setHead to another branch first.',
    })
  })

  it('returns 404 for a missing branch', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/ghost', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for an invalid branch name', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/bad.slug', {
      method: 'DELETE',
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_branch_name',
      message: 'Invalid branch name "bad.slug": kebab-case ASCII only',
    })
  })
})

describe('PUT /api/workspaces/:sid/canvases/:slug/head', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'branches-route-test-'))
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('switches to an existing branch and returns 200 with head and previousHead', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { head: string; previousHead: string }
    expect(body).toEqual({ head: 'feature', previousHead: 'main' })
  })

  it('returns 404 for a missing branch', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'ghost' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when the body is invalid and branch is missing', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid branch name', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'bad.slug' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_branch_name',
      message: 'Invalid branch name "bad.slug": kebab-case ASCII only',
    })
  })

  // Head switching integrates checkout, previous-tip persistence, and broadcasts.
  describe('checkout integration', () => {
    it('calls getCurrentFrontiers and updates the previous HEAD tipFrontiers with the current frontiers', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, slug: string) => Promise<string | null>>()
        .mockResolvedValue('CURRENTFR==')
      const checkoutTo = vi.fn<(sid: string, slug: string, tip: string) => Promise<void>>()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(getCurrentFrontiers).toHaveBeenCalledWith('s1', 'canvas-a')

      // Confirm that main.tipFrontiers was updated in the branches list.
      const list = await app.request('/api/workspaces/s1/canvases/canvas-a/branches')
      const body = (await list.json()) as {
        branches: Array<{ name: string; tipFrontiers: string }>
      }
      expect(body.branches.find((b) => b.name === 'main')?.tipFrontiers).toBe('CURRENTFR==')
    })

    it('does not call checkoutTo when the new HEAD tipFrontiers is an empty string', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, slug: string) => Promise<string | null>>()
        .mockResolvedValue('X==')
      const checkoutTo = vi.fn<(sid: string, slug: string, tip: string) => Promise<void>>()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      // feature is created without initialTipFrontiers, so tipFrontiers="".
      await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(checkoutTo).not.toHaveBeenCalled()
    })

    it('calls checkoutTo(sid, slug, tip) when the new HEAD tipFrontiers is non-empty', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, slug: string) => Promise<string | null>>()
        .mockResolvedValue('CUR==')
      const checkoutTo = vi
        .fn<(sid: string, slug: string, tip: string) => Promise<void>>()
        .mockResolvedValue()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature', fromVersionId: undefined }),
      })
      // Overwrite feature.tipFrontiers directly for the test.
      // In production this would normally happen through updateBranchTip.
      const { saveCanvasBranches, loadCanvasBranches } = await import('../store/branches-store.js')
      const state = await loadCanvasBranches('s1', 'canvas-a')
      const feature = state.branches.find((b) => b.name === 'feature')!
      feature.tipFrontiers = 'FEATURE_TIP=='
      await saveCanvasBranches('s1', 'canvas-a', state)

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(checkoutTo).toHaveBeenCalledWith('s1', 'canvas-a', 'FEATURE_TIP==')
    })

    it('skips previous-tip updates when getCurrentFrontiers returns null', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, slug: string) => Promise<string | null>>()
        .mockResolvedValue(null)
      const checkoutTo = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      const list = await app.request('/api/workspaces/s1/canvases/canvas-a/branches')
      const body = (await list.json()) as {
        branches: Array<{ name: string; tipFrontiers: string }>
      }
      // main.tipFrontiers should stay at the lazy-default empty string.
      expect(body.branches.find((b) => b.name === 'main')?.tipFrontiers).toBe('')
    })

    it('returns 500 without changing head or tips when getCurrentFrontiers throws corruption', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, slug: string) => Promise<string | null>>()
        .mockRejectedValue(corruptStoredData('/tmp/canvas-a.loro', 'invalid canvas snapshot'))
      const checkoutTo = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const { loadCanvasBranches } = await import('../store/branches-store.js')
      const before = await loadCanvasBranches('s1', 'canvas-a')

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })

      expect(res.status).toBe(500)
      await expect(res.json()).resolves.toEqual({
        error: 'corrupt_stored_data',
        message: expect.stringContaining('invalid canvas snapshot'),
      })
      expect(checkoutTo).not.toHaveBeenCalled()
      await expect(loadCanvasBranches('s1', 'canvas-a')).resolves.toEqual(before)
    })

    it('returns 500 without changing head or tips when checkoutTo throws corruption', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, slug: string) => Promise<string | null>>()
        .mockResolvedValue('CURRENT==')
      const checkoutTo = vi
        .fn<(sid: string, slug: string, tip: string) => Promise<void>>()
        .mockRejectedValue(corruptStoredData('/tmp/branches.json', 'target tip is invalid'))
      const notifyHeadChanged = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo, notifyHeadChanged })

      await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const { loadCanvasBranches, saveCanvasBranches } = await import('../store/branches-store.js')
      const state = await loadCanvasBranches('s1', 'canvas-a')
      const feature = state.branches.find((branch) => branch.name === 'feature')!
      feature.tipFrontiers = 'FEATURE_TIP=='
      await saveCanvasBranches('s1', 'canvas-a', state)
      const before = await loadCanvasBranches('s1', 'canvas-a')

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })

      expect(res.status).toBe(500)
      await expect(res.json()).resolves.toEqual({
        error: 'corrupt_stored_data',
        message: expect.stringContaining('target tip is invalid'),
      })
      expect(checkoutTo).toHaveBeenCalledWith('s1', 'canvas-a', 'FEATURE_TIP==')
      expect(notifyHeadChanged).not.toHaveBeenCalled()
      await expect(loadCanvasBranches('s1', 'canvas-a')).resolves.toEqual(before)
    })

    it('short-circuits idempotently when setting head to the same branch', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, slug: string) => Promise<string | null>>()
        .mockResolvedValue('X==')
      const checkoutTo = vi.fn()
      const notifyHeadChanged = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo, notifyHeadChanged })

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'main' }),
      })
      expect(res.status).toBe(200)
      expect(getCurrentFrontiers).not.toHaveBeenCalled()
      expect(checkoutTo).not.toHaveBeenCalled()
      expect(notifyHeadChanged).not.toHaveBeenCalled()
    })

    it('calls notifyHeadChanged(sid, slug, newHead) after head switching completes', async () => {
      const notifyHeadChanged = vi.fn<(sid: string, slug: string, head: string) => void>()
      const app = makeApp({ notifyHeadChanged })

      await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/canvases/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(notifyHeadChanged).toHaveBeenCalledWith('s1', 'canvas-a', 'feature')
    })
  })
})

describe('PATCH /api/workspaces/:sid/canvases/:slug/branches/:name', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'branches-route-test-'))
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('renames an existing branch and returns 200 with branch and renamedVersionCount', async () => {
    const renameInVersions = vi
      .fn<(sid: string, slug: string, oldName: string, newName: string) => Promise<number>>()
      .mockResolvedValue(3)
    const app = makeApp({ renameInVersions })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'experimental' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      branch: { name: string }
      renamedVersionCount: number
    }
    expect(body.branch.name).toBe('experimental')
    expect(body.renamedVersionCount).toBe(3)
    expect(renameInVersions).toHaveBeenCalledWith('s1', 'canvas-a', 'feature', 'experimental')
  })

  it('returns 409 when renaming main', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/main', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mainline' }),
    })
    expect(res.status).toBe(409)
  })

  it('returns 404 when renaming a missing branch', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/ghost', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'gh' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns structured 400 when the new name is invalid', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad/name' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when body.name is missing', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 500 and rolls back the branch rename when renameInVersions reports corruption', async () => {
    const app = makeApp({
      renameInVersions: vi
        .fn<(sid: string, slug: string, oldName: string, newName: string) => Promise<number>>()
        .mockRejectedValue(corruptStoredData('/tmp/versions', 'broken version metadata')),
    })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'experimental' }),
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken version metadata'),
    })

    const branchesRes = await app.request('/api/workspaces/s1/canvases/canvas-a/branches')
    const body = (await branchesRes.json()) as { branches: Array<{ name: string }> }
    expect(body.branches.map((branch) => branch.name)).toContain('feature')
    expect(body.branches.map((branch) => branch.name)).not.toContain('experimental')
  })
})

describe('POST /api/workspaces/:sid/canvases/:slug/branches/:source/merge', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'branches-route-test-'))
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('calls performMerge with dryRun=true and returns preview + badges without changing tips', async () => {
    const performMerge = vi
      .fn<
        (
          sid: string,
          slug: string,
          args: { source: string; into: string; dryRun: boolean },
        ) => Promise<{
          previewElementCount: number
          badges: Array<{ type: string; elementId: string }>
          committed: boolean
        }>
      >()
      .mockResolvedValue({
        previewElementCount: 5,
        badges: [{ type: 'resurrected', elementId: 'a' }],
        committed: false,
      })
    const app = makeApp({ performMerge })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main', dryRun: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      preview: { elementCount: number }
      badges: unknown[]
    }
    expect(body.preview.elementCount).toBe(5)
    expect(body.badges).toHaveLength(1)
    expect(performMerge).toHaveBeenCalledWith('s1', 'canvas-a', {
      source: 'feature',
      into: 'main',
      dryRun: true,
    })
  })

  it('returns committed for the default dryRun=false path', async () => {
    const performMerge = vi.fn().mockResolvedValue({
      previewElementCount: 7,
      badges: [],
      committed: true,
    })
    const app = makeApp({ performMerge })
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      committed: { elementCount: number }
      badges: unknown[]
    }
    expect(body.committed.elementCount).toBe(7)
    expect(performMerge).toHaveBeenCalledWith('s1', 'canvas-a', {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })
  })

  it('returns 400 when into is missing', async () => {
    const app = makeApp({ performMerge: vi.fn() })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when source has an invalid name', async () => {
    const app = makeApp({ performMerge: vi.fn() })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/bad.slug/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when source == into', async () => {
    const app = makeApp({ performMerge: vi.fn() })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/main/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the source branch does not exist', async () => {
    const performMerge = vi.fn().mockRejectedValue(
      Object.assign(new Error('Branch "ghost" not found on s1/canvas-a'), {
        name: 'BranchNotFoundError',
      }),
    )
    const app = makeApp({ performMerge })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/ghost/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 501 unsupported_merge when performMerge is not injected', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/canvases/canvas-a/branches/feature/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(501)
  })
})
