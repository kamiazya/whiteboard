import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { apiErrorBodySchema, apiErrorReason } from '../../shared/api-contracts/errors.js'
import { withTempDataDir } from './_test-helpers.js'

const tmp = withTempDataDir('branches-route-test-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createBranchesRouter } = await import('./branches.js')
const { corruptStoredData } = await import('../store/corrupt-stored-data.js')
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import('../store/document-store.js')
const { clearCache } = await import('../store/doc-cache.js')
const { LoroDoc } = await import('loro-crdt')
const { beforeEach } = await import('vitest')

// Branch writers refuse a path with no document, so the canvas every test
// routes to is seeded first — the shape production always has.
beforeEach(async () => {
  clearCache()
  _clearWorkspaceDocCacheForTests()
  await saveDocument('s1', 'canvas-a', new LoroDoc(), { kind: 'spatial' })
})

type PerformMergeFn = (
  sid: string,
  path: string,
  args: { source: string; into: string; dryRun: boolean },
) => Promise<{
  previewElementCount: number
  badges: Array<Record<string, unknown>>
  committed: boolean
}>

type RenameInVersionsFn = (
  sid: string,
  path: string,
  oldName: string,
  newName: string,
) => Promise<number>

function makeApp(
  opts: {
    resolveFromVersionFrontiers?: (sid: string, id: string) => Promise<string | null>
    getCurrentFrontiers?: (sid: string, path: string) => Promise<string | null>
    checkoutTo?: (sid: string, path: string, tipFrontiersBase64: string) => Promise<void>
    notifyHeadChanged?: (sid: string, path: string, head: string) => void
    performMerge?: PerformMergeFn
    renameInVersions?: RenameInVersionsFn
    countVersionsOnBranch?: (sid: string, path: string, branch: string) => Promise<number>
    loadDocumentAtTip?: (
      sid: string,
      path: string,
      tip: string,
    ) => Promise<import('../../shared/api-contracts/document.js').VersionDocumentResponse | null>
  } = {},
) {
  const app = new Hono()
  app.route('/', createBranchesRouter(opts))
  return app
}

describe('POST /api/workspaces/:sid/documents/:path/branches', () => {
  it('creates a new branch and returns 201 with the branch', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'main' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('branch_conflict')
    expect(body.message).toMatch(/already exists/i)
  })

  it('emits a 409 body the shared error contract parses, with the reason recoverable', async () => {
    // The client reads every daemon error through apiErrorBodySchema /
    // apiErrorReason. A route emitting a shape outside the contract would
    // strand its reason behind the generic fallback — which is exactly how
    // "A variation named X already exists" was discarded for months.
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'main' }),
    })
    expect(res.status).toBe(409)
    const body: unknown = await res.json()
    expect(apiErrorBodySchema.safeParse(body).success).toBe(true)
    expect(apiErrorReason(body)).toMatch(/already exists/i)
  })

  it('returns 400 for an invalid name', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
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

  it('returns structured 400 responses for invalid sid and path', async () => {
    const app = makeApp()

    const badSession = await app.request('/api/workspaces/bad.sid/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature-x' }),
    })
    expect(badSession.status).toBe(400)
    await expect(badSession.json()).resolves.toEqual({
      error: 'invalid_workspace_id',
      message: 'Invalid workspaceId "bad.sid": only ASCII letters, digits, "_" and "-" are allowed',
    })

    const badPath = await app.request('/api/workspaces/s1/documents/bad.path/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature-x' }),
    })
    expect(badPath.status).toBe(400)
    await expect(badPath.json()).resolves.toEqual({
      error: 'invalid_document_path',
      message:
        'Invalid path "bad.path": segment "bad.path" contains \'.\' (only letters, digits, and \'-\' are allowed)',
    })
  })

  it('initializes tipFrontiers through the injected resolver when fromVersionId is provided', async () => {
    const resolve = vi
      .fn<(sid: string, id: string) => Promise<string | null>>()
      .mockResolvedValue('AAECAw==')
    const app = makeApp({ resolveFromVersionFrontiers: resolve })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
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

  it('returns 400 invalid_body with message "malformed JSON" when body is not valid JSON', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'malformed JSON',
    })
  })

  it('returns 400 invalid_body with message "name is required" when body is valid JSON but name is missing', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'name is required',
    })
  })
})

describe('GET /api/workspaces/:sid/documents/:path/branches', () => {
  it('returns main as the only branch with head="main" in the initial lazy-default state', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      branches: Array<{ name: string }>
      head: string
    }
    expect(body.head).toBe('main')
    expect(body.branches.map((b) => b.name)).toEqual(['main'])
  })

  it('returns structured 400 responses for invalid sid and path', async () => {
    const app = makeApp()

    const badSession = await app.request('/api/workspaces/bad.sid/documents/canvas-a/branches')
    expect(badSession.status).toBe(400)
    await expect(badSession.json()).resolves.toEqual({
      error: 'invalid_workspace_id',
      message: 'Invalid workspaceId "bad.sid": only ASCII letters, digits, "_" and "-" are allowed',
    })

    const badPath = await app.request('/api/workspaces/s1/documents/bad.path/branches')
    expect(badPath.status).toBe(400)
    await expect(badPath.json()).resolves.toEqual({
      error: 'invalid_document_path',
      message:
        'Invalid path "bad.path": segment "bad.path" contains \'.\' (only letters, digits, and \'-\' are allowed)',
    })
  })
})

describe('GET /api/workspaces/:sid/documents/:path/branches/:name/stats', () => {
  it('returns unmergedCommits from the injected countVersionsOnBranch', async () => {
    const countVersionsOnBranch = vi
      .fn<(sid: string, path: string, branch: string) => Promise<number>>()
      .mockResolvedValue(7)
    const app = makeApp({ countVersionsOnBranch })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature/stats')
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
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    await app.request('/api/workspaces/s1/documents/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature/stats')
    const body = (await res.json()) as { unmergedCommits: number; isHead: boolean }
    expect(body.isHead).toBe(true)
  })

  it('returns 404 for a missing branch', async () => {
    const app = makeApp({
      countVersionsOnBranch: vi.fn().mockResolvedValue(0),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/ghost/stats')
    expect(res.status).toBe(404)
  })

  it('returns structured 500 instead of 200 + 0 when countVersionsOnBranch reports corruption', async () => {
    const app = makeApp({
      countVersionsOnBranch: vi
        .fn<(sid: string, path: string, branch: string) => Promise<number>>()
        .mockRejectedValue(corruptStoredData('/tmp/versions', 'broken version metadata')),
    })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature/stats')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken version metadata'),
    })
  })
})

describe('DELETE /api/workspaces/:sid/documents/:path/branches/:name', () => {
  it('deletes an existing non-HEAD branch with 200', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; unmergedCommits: number }
    expect(body.ok).toBe(true)
    expect(typeof body.unmergedCommits).toBe('number')
  })

  it('returns a real unmergedCommits count when countVersionsOnBranch is injected', async () => {
    const countVersionsOnBranch = vi
      .fn<(sid: string, path: string, branch: string) => Promise<number>>()
      .mockResolvedValue(3)
    const app = makeApp({ countVersionsOnBranch })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; unmergedCommits: number }
    expect(body.unmergedCommits).toBe(3)
    expect(countVersionsOnBranch).toHaveBeenCalledWith('s1', 'canvas-a', 'feature')
  })

  it('returns unmergedCommits=0 when countVersionsOnBranch is not injected', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'DELETE',
    })
    const body = (await res.json()) as { unmergedCommits: number }
    expect(body.unmergedCommits).toBe(0)
  })

  it('returns 500 and keeps the branch when countVersionsOnBranch reports corruption after delete', async () => {
    const app = makeApp({
      countVersionsOnBranch: vi
        .fn<(sid: string, path: string, branch: string) => Promise<number>>()
        .mockRejectedValue(corruptStoredData('/tmp/versions', 'broken version metadata')),
    })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'DELETE',
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken version metadata'),
    })

    const branchesRes = await app.request('/api/workspaces/s1/documents/canvas-a/branches')
    const body = (await branchesRes.json()) as { branches: Array<{ name: string }> }
    expect(body.branches.map((branch) => branch.name)).toContain('feature')
  })

  it('returns 409 when deleting main', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/main', {
      method: 'DELETE',
    })
    expect(res.status).toBe(409)
  })

  it('returns 409 when deleting the HEAD branch', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    await app.request('/api/workspaces/s1/documents/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/ghost', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for an invalid branch name', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/bad.path', {
      method: 'DELETE',
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_branch_name',
      message: 'Invalid branch name "bad.path": kebab-case ASCII only',
    })
  })
})

describe('PUT /api/workspaces/:sid/documents/:path/head', () => {
  it('switches to an existing branch and returns 200 with head and previousHead', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'ghost' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when the body is invalid and branch is missing', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid branch name', async () => {
    const app = makeApp()
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'bad.path' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_branch_name',
      message: 'Invalid branch name "bad.path": kebab-case ASCII only',
    })
  })

  // Head switching integrates checkout, previous-tip persistence, and broadcasts.
  describe('checkout integration', () => {
    it('calls getCurrentFrontiers and updates the previous HEAD tipFrontiers with the current frontiers', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, path: string) => Promise<string | null>>()
        .mockResolvedValue('CURRENTFR==')
      const checkoutTo = vi.fn<(sid: string, path: string, tip: string) => Promise<void>>()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(getCurrentFrontiers).toHaveBeenCalledWith('s1', 'canvas-a')

      // Confirm that main.tipFrontiers was updated in the branches list.
      const list = await app.request('/api/workspaces/s1/documents/canvas-a/branches')
      const body = (await list.json()) as {
        branches: Array<{ name: string; tipFrontiers: string }>
      }
      expect(body.branches.find((b) => b.name === 'main')?.tipFrontiers).toBe('CURRENTFR==')
    })

    it('does not call checkoutTo when the new HEAD tipFrontiers is an empty string', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, path: string) => Promise<string | null>>()
        .mockResolvedValue('X==')
      const checkoutTo = vi.fn<(sid: string, path: string, tip: string) => Promise<void>>()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      // feature is created without initialTipFrontiers, so tipFrontiers="".
      await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(checkoutTo).not.toHaveBeenCalled()
    })

    it('calls checkoutTo(sid, path, tip) when the new HEAD tipFrontiers is non-empty', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, path: string) => Promise<string | null>>()
        .mockResolvedValue('CUR==')
      const checkoutTo = vi
        .fn<(sid: string, path: string, tip: string) => Promise<void>>()
        .mockResolvedValue()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature', fromVersionId: undefined }),
      })
      // Overwrite feature.tipFrontiers directly for the test.
      // In production this would normally happen through updateBranchTip.
      const { saveDocumentBranches, loadDocumentBranches } = await import(
        '../store/branches-store.js'
      )
      const state = await loadDocumentBranches('s1', 'canvas-a')
      const feature = state.branches.find((b) => b.name === 'feature')!
      feature.tipFrontiers = 'FEATURE_TIP=='
      await saveDocumentBranches('s1', 'canvas-a', state)

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(checkoutTo).toHaveBeenCalledWith('s1', 'canvas-a', 'FEATURE_TIP==')
    })

    it('skips previous-tip updates when getCurrentFrontiers returns null', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, path: string) => Promise<string | null>>()
        .mockResolvedValue(null)
      const checkoutTo = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      const list = await app.request('/api/workspaces/s1/documents/canvas-a/branches')
      const body = (await list.json()) as {
        branches: Array<{ name: string; tipFrontiers: string }>
      }
      // main.tipFrontiers should stay at the lazy-default empty string.
      expect(body.branches.find((b) => b.name === 'main')?.tipFrontiers).toBe('')
    })

    it('returns 500 without changing head or tips when getCurrentFrontiers throws corruption', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, path: string) => Promise<string | null>>()
        .mockRejectedValue(corruptStoredData('/tmp/canvas-a.loro', 'invalid canvas snapshot'))
      const checkoutTo = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo })

      await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const { loadDocumentBranches } = await import('../store/branches-store.js')
      const before = await loadDocumentBranches('s1', 'canvas-a')

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
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
      await expect(loadDocumentBranches('s1', 'canvas-a')).resolves.toEqual(before)
    })

    it('returns 500 without changing head or tips when checkoutTo throws corruption', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, path: string) => Promise<string | null>>()
        .mockResolvedValue('CURRENT==')
      const checkoutTo = vi
        .fn<(sid: string, path: string, tip: string) => Promise<void>>()
        .mockRejectedValue(corruptStoredData('/tmp/branches.json', 'target tip is invalid'))
      const notifyHeadChanged = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo, notifyHeadChanged })

      await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const { loadDocumentBranches, saveDocumentBranches } = await import(
        '../store/branches-store.js'
      )
      const state = await loadDocumentBranches('s1', 'canvas-a')
      const feature = state.branches.find((branch) => branch.name === 'feature')!
      feature.tipFrontiers = 'FEATURE_TIP=='
      await saveDocumentBranches('s1', 'canvas-a', state)
      const before = await loadDocumentBranches('s1', 'canvas-a')

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
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
      await expect(loadDocumentBranches('s1', 'canvas-a')).resolves.toEqual(before)
    })

    it('short-circuits idempotently when setting head to the same branch', async () => {
      const getCurrentFrontiers = vi
        .fn<(sid: string, path: string) => Promise<string | null>>()
        .mockResolvedValue('X==')
      const checkoutTo = vi.fn()
      const notifyHeadChanged = vi.fn()
      const app = makeApp({ getCurrentFrontiers, checkoutTo, notifyHeadChanged })

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'main' }),
      })
      expect(res.status).toBe(200)
      expect(getCurrentFrontiers).not.toHaveBeenCalled()
      expect(checkoutTo).not.toHaveBeenCalled()
      expect(notifyHeadChanged).not.toHaveBeenCalled()
    })

    it('calls notifyHeadChanged(sid, path, newHead) after head switching completes', async () => {
      const notifyHeadChanged = vi.fn<(sid: string, path: string, head: string) => void>()
      const app = makeApp({ notifyHeadChanged })

      await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })

      const res = await app.request('/api/workspaces/s1/documents/canvas-a/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      })
      expect(res.status).toBe(200)
      expect(notifyHeadChanged).toHaveBeenCalledWith('s1', 'canvas-a', 'feature')
    })
  })
})

describe('PATCH /api/workspaces/:sid/documents/:path/branches/:name', () => {
  it('renames an existing branch and returns 200 with branch and renamedVersionCount', async () => {
    const renameInVersions = vi
      .fn<(sid: string, path: string, oldName: string, newName: string) => Promise<number>>()
      .mockResolvedValue(3)
    const app = makeApp({ renameInVersions })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/main', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mainline' }),
    })
    expect(res.status).toBe(409)
  })

  it('returns 404 when renaming a missing branch', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/ghost', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'gh' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns structured 400 when the new name is invalid', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad/name' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when body.name is missing', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 invalid_body with message "malformed JSON" when rename body is not valid JSON', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'malformed JSON',
    })
  })

  it('returns 400 invalid_body with message "name is required" when rename body is valid JSON but name is missing', async () => {
    const app = makeApp({ renameInVersions: vi.fn().mockResolvedValue(0) })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'name is required',
    })
  })

  it('returns 500 and rolls back the branch rename when renameInVersions reports corruption', async () => {
    const app = makeApp({
      renameInVersions: vi
        .fn<(sid: string, path: string, oldName: string, newName: string) => Promise<number>>()
        .mockRejectedValue(corruptStoredData('/tmp/versions', 'broken version metadata')),
    })
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'experimental' }),
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken version metadata'),
    })

    const branchesRes = await app.request('/api/workspaces/s1/documents/canvas-a/branches')
    const body = (await branchesRes.json()) as { branches: Array<{ name: string }> }
    expect(body.branches.map((branch) => branch.name)).toContain('feature')
    expect(body.branches.map((branch) => branch.name)).not.toContain('experimental')
  })
})

describe('POST /api/workspaces/:sid/documents/:path/branches/:source/merge', () => {
  it('calls performMerge with dryRun=true and returns preview + badges without changing tips', async () => {
    const performMerge = vi
      .fn<
        (
          sid: string,
          path: string,
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
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature/merge', {
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
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature/merge', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when source has an invalid name', async () => {
    const app = makeApp({ performMerge: vi.fn() })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/bad.path/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when source == into', async () => {
    const app = makeApp({ performMerge: vi.fn() })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/main/merge', {
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
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/ghost/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 501 unsupported_merge when performMerge is not injected', async () => {
    const app = makeApp()
    await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/feature/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: 'main' }),
    })
    expect(res.status).toBe(501)
  })
})

describe('GET /api/workspaces/:sid/documents/:path/branches/:name/document', () => {
  // The read that makes a variation ADDRESSABLE (ADR-0022's later increment):
  // content at the branch tip, projected read-only, without moving HEAD.
  const seed = async (app: Hono, name: string) => {
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    expect(res.status).toBe(201)
  }

  it('projects the branch tip through the injected loadDocumentAtTip', async () => {
    const calls: string[][] = []
    const app = makeApp({
      // A tip only exists once something recorded one; fromVersionId is the
      // route-level way to mint a branch with a concrete tip.
      resolveFromVersionFrontiers: async () => 'dGlwLWZyb250aWVycw==',
      loadDocumentAtTip: async (sid, path, tip) => {
        calls.push([sid, path, tip])
        return { kind: 'markdown', body: '# at the tip' }
      },
    })
    const created = await app.request('/api/workspaces/s1/documents/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'idea', fromVersionId: 'v_0123456789abcdef' }),
    })
    expect(created.status).toBe(201)
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/idea/document')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: 'markdown', body: '# at the tip' })
    expect(calls).toEqual([['s1', 'canvas-a', 'dGlwLWZyb250aWVycw==']])
  })

  it('passes an empty tip for an uninitialized branch (its content is the live document)', async () => {
    const calls: string[] = []
    const app = makeApp({
      loadDocumentAtTip: async (_sid, _path, tip) => {
        calls.push(tip)
        return { kind: 'spatial', canvas: { nodes: [], edges: [] } }
      },
    })
    await seed(app, 'fresh')
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/fresh/document')
    expect(res.status).toBe(200)
    expect(calls).toEqual([''])
  })

  it('returns 404 for a branch that does not exist', async () => {
    const app = makeApp({ loadDocumentAtTip: async () => ({ kind: 'markdown', body: '' }) })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/nope/document')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the seam cannot check the tip out', async () => {
    const app = makeApp({
      loadDocumentAtTip: async () => null,
    })
    await seed(app, 'gone')
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/gone/document')
    expect(res.status).toBe(404)
  })

  it('returns 501 when the deployment has no loadDocumentAtTip', async () => {
    const app = makeApp()
    await seed(app, 'idea')
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/idea/document')
    expect(res.status).toBe(501)
  })

  it('returns structured 400 for an invalid branch name', async () => {
    const app = makeApp({ loadDocumentAtTip: async () => null })
    const res = await app.request('/api/workspaces/s1/documents/canvas-a/branches/%20/document')
    expect(res.status).toBe(400)
    expect(apiErrorBodySchema.safeParse(await res.json()).success).toBe(true)
  })
})
