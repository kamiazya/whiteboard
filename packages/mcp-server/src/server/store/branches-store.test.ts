import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Declare this first because vi.mock is hoisted.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const {
  loadCanvasBranches,
  saveCanvasBranches,
  createBranch,
  deleteBranch,
  setHead,
  updateBranchTip,
  getBranchTipBase64,
  renameBranch,
  DEFAULT_MAIN_COLOR,
} = await import('./branches-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { withWorkspaceWriteLock, _resetWorkspaceLocksForTests } = await import('./workspace-lock.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

describe('branches-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-branches-test-'))
    handle = await createIsolatedDb({ dataDir: tempDir })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
    _resetWorkspaceLocksForTests()
  })

  describe('loadCanvasBranches (lazy default)', () => {
    it('returns the default main branch state when no rows exist', async () => {
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.head).toBe('main')
      expect(state.branches).toHaveLength(1)
      expect(state.branches[0]).toMatchObject({
        name: 'main',
        tipFrontiers: '',
        color: DEFAULT_MAIN_COLOR,
      })
      // createdAt is an ISO string.
      expect(state.branches[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('returns independent objects for each lazy default call', async () => {
      const a = await loadCanvasBranches('sess-a', 'canvas-x')
      const b = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(a).not.toBe(b)
      expect(a.branches).not.toBe(b.branches)
    })
  })

  describe('saveCanvasBranches + round-trip', () => {
    it('round-trips every BranchMeta field through save/load', async () => {
      const state = {
        head: 'feature-x',
        branches: [
          {
            name: 'main',
            tipFrontiers: 'AAECAw==', // base64
            color: '#1971c2',
            createdAt: '2026-04-23T00:00:00.000Z',
          },
          {
            name: 'feature-x',
            tipFrontiers: 'BAUGBw==',
            baseBranch: 'main',
            baseVersionId: 'v-abc',
            color: '#9333ea',
            createdAt: '2026-04-23T01:00:00.000Z',
          },
        ],
      }
      await saveCanvasBranches('sess-a', 'canvas-x', state)
      const loaded = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(loaded).toEqual(state)
    })

    it('saves and loads nested paths such as "621/header"', async () => {
      const state = {
        head: 'main',
        branches: [
          {
            name: 'main',
            tipFrontiers: '',
            color: '#1971c2',
            createdAt: '2026-04-23T00:00:00.000Z',
          },
        ],
      }
      await saveCanvasBranches('sess-a', '621/header', state)
      const loaded = await loadCanvasBranches('sess-a', '621/header')
      expect(loaded).toEqual(state)
    })

    it('rejects invalid workspaceIds such as path traversal input', async () => {
      const state = {
        head: 'main',
        branches: [
          {
            name: 'main',
            tipFrontiers: '',
            color: '#1971c2',
            createdAt: '2026-04-23T00:00:00.000Z',
          },
        ],
      }
      await expect(saveCanvasBranches('../evil', 'x', state)).rejects.toThrow(/Invalid workspaceId/)
    })

    it('rejects invalid paths such as empty strings, "..", and "/foo"', async () => {
      const state = {
        head: 'main',
        branches: [
          {
            name: 'main',
            tipFrontiers: '',
            color: '#1971c2',
            createdAt: '2026-04-23T00:00:00.000Z',
          },
        ],
      }
      await expect(saveCanvasBranches('sess', '', state)).rejects.toThrow(/Invalid path/)
      await expect(saveCanvasBranches('sess', '/foo', state)).rejects.toThrow(/Invalid path/)
      await expect(saveCanvasBranches('sess', '../x', state)).rejects.toThrow(/Invalid path/)
    })
  })

  describe('createBranch', () => {
    it('creates and returns a new branch with tipFrontiers, baseBranch, and baseVersionId', async () => {
      const branch = await createBranch('sess-a', 'canvas-x', {
        name: 'feature',
        initialTipFrontiers: 'AAECAw==',
        baseBranch: 'main',
        baseVersionId: 'v-abc',
        color: '#9333ea',
      })
      expect(branch.name).toBe('feature')
      expect(branch.tipFrontiers).toBe('AAECAw==')
      expect(branch.baseBranch).toBe('main')
      expect(branch.baseVersionId).toBe('v-abc')
      expect(branch.color).toBe('#9333ea')
      expect(branch.createdAt).toMatch(/^\d{4}-/)

      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.branches.map((b) => b.name).sort()).toEqual(['feature', 'main'])
    })

    it('uses "" and a default color when initialTipFrontiers and color are omitted', async () => {
      const branch = await createBranch('sess-a', 'canvas-x', { name: 'x' })
      expect(branch.tipFrontiers).toBe('')
      expect(branch.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    })

    it('throws ConflictError for duplicate branch names', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      await expect(createBranch('sess-a', 'canvas-x', { name: 'feature' })).rejects.toThrow(
        /already exists/i,
      )
    })

    it('throws ConflictError when trying to create main again', async () => {
      await expect(createBranch('sess-a', 'canvas-x', { name: 'main' })).rejects.toThrow(
        /already exists/i,
      )
    })

    it('validates branch names with the same rules as paths', async () => {
      await expect(createBranch('sess-a', 'canvas-x', { name: '' })).rejects.toThrow(
        /Invalid branch name/,
      )
      await expect(createBranch('sess-a', 'canvas-x', { name: 'a/b' })).rejects.toThrow(
        /Invalid branch name/,
      )
    })
  })

  describe('deleteBranch', () => {
    it('deletes an existing branch', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      const result = await deleteBranch('sess-a', 'canvas-x', 'feature')
      expect(result.ok).toBe(true)
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.branches.map((b) => b.name)).toEqual(['main'])
    })

    it('does not allow deleting main', async () => {
      await expect(deleteBranch('sess-a', 'canvas-x', 'main')).rejects.toThrow(
        /cannot delete main/i,
      )
    })

    it('does not allow deleting the current HEAD branch', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      await setHead('sess-a', 'canvas-x', 'feature')
      await expect(deleteBranch('sess-a', 'canvas-x', 'feature')).rejects.toThrow(/HEAD/i)
    })

    it('throws NotFound for a missing branch', async () => {
      await expect(deleteBranch('sess-a', 'canvas-x', 'ghost')).rejects.toThrow(/not found/i)
    })
  })

  describe('setHead', () => {
    it('switches head to an existing branch', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      const result = await setHead('sess-a', 'canvas-x', 'feature')
      expect(result).toEqual({ head: 'feature', previousHead: 'main' })
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.head).toBe('feature')
    })

    it('throws NotFound when setting head to a missing branch', async () => {
      await expect(setHead('sess-a', 'canvas-x', 'ghost')).rejects.toThrow(/not found/i)
    })

    it('is idempotent when setting head to the current branch', async () => {
      const r = await setHead('sess-a', 'canvas-x', 'main')
      expect(r).toEqual({ head: 'main', previousHead: 'main' })
    })
  })

  describe('updateBranchTip', () => {
    it('overwrites tipFrontiers on an existing branch', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      await updateBranchTip('sess-a', 'canvas-x', 'feature', 'AAECAw==')
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.branches.find((b) => b.name === 'feature')?.tipFrontiers).toBe('AAECAw==')
    })

    it('also updates main.tipFrontiers', async () => {
      await updateBranchTip('sess-a', 'canvas-x', 'main', 'BAUGBw==')
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.branches.find((b) => b.name === 'main')?.tipFrontiers).toBe('BAUGBw==')
    })

    it('throws NotFound when updating a missing branch tip', async () => {
      await expect(updateBranchTip('sess-a', 'canvas-x', 'ghost', 'AA==')).rejects.toThrow(
        /not found/i,
      )
    })

    it('accepts an empty string for tipFrontiers', async () => {
      await createBranch('sess-a', 'canvas-x', {
        name: 'feature',
        initialTipFrontiers: 'AAECAw==',
      })
      await updateBranchTip('sess-a', 'canvas-x', 'feature', '')
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.branches.find((b) => b.name === 'feature')?.tipFrontiers).toBe('')
    })
  })

  describe('getBranchTipBase64', () => {
    it('returns tipFrontiers for an existing branch', async () => {
      await createBranch('sess-a', 'canvas-x', {
        name: 'feature',
        initialTipFrontiers: 'AAECAw==',
      })
      const tip = await getBranchTipBase64('sess-a', 'canvas-x', 'feature')
      expect(tip).toBe('AAECAw==')
    })

    it('returns "" when tipFrontiers is empty', async () => {
      const tip = await getBranchTipBase64('sess-a', 'canvas-x', 'main')
      expect(tip).toBe('')
    })

    it('returns null for a missing branch', async () => {
      const tip = await getBranchTipBase64('sess-a', 'canvas-x', 'ghost')
      expect(tip).toBeNull()
    })
  })

  describe('renameBranch', () => {
    it('renames an existing branch while preserving all fields', async () => {
      await createBranch('sess-a', 'canvas-x', {
        name: 'feature',
        initialTipFrontiers: 'AAECAw==',
        color: '#9333ea',
      })
      const result = await renameBranch('sess-a', 'canvas-x', 'feature', 'experimental')
      expect(result.name).toBe('experimental')
      expect(result.tipFrontiers).toBe('AAECAw==')
      expect(result.color).toBe('#9333ea')
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.branches.map((b) => b.name).sort()).toEqual(['experimental', 'main'])
    })

    it('renames head when the renamed branch is the current head', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      await setHead('sess-a', 'canvas-x', 'feature')
      await renameBranch('sess-a', 'canvas-x', 'feature', 'experimental')
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      expect(state.head).toBe('experimental')
    })

    it('does not allow renaming main', async () => {
      await expect(renameBranch('sess-a', 'canvas-x', 'main', 'mainline')).rejects.toThrow(
        /cannot rename main/i,
      )
    })

    it('throws Conflict when the new name already exists', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'a' })
      await createBranch('sess-a', 'canvas-x', { name: 'b' })
      await expect(renameBranch('sess-a', 'canvas-x', 'a', 'b')).rejects.toMatchObject({
        name: 'BranchConflictError',
      })
    })

    it('throws NotFound when renaming a missing branch', async () => {
      await expect(renameBranch('sess-a', 'canvas-x', 'ghost', 'gh')).rejects.toMatchObject({
        name: 'BranchNotFoundError',
      })
    })

    it('throws ValidationError for invalid new names', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      await expect(renameBranch('sess-a', 'canvas-x', 'feature', '')).rejects.toThrow(
        /invalid branch name/i,
      )
      await expect(renameBranch('sess-a', 'canvas-x', 'feature', 'bad/name')).rejects.toThrow(
        /"\/"|invalid branch name/i,
      )
    })

    it('treats rename-to-self as a no-op', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      const result = await renameBranch('sess-a', 'canvas-x', 'feature', 'feature')
      expect(result.name).toBe('feature')
    })

    it('updates dependent baseBranch references to the renamed branch', async () => {
      await createBranch('sess-a', 'canvas-x', { name: 'feature' })
      await createBranch('sess-a', 'canvas-x', {
        name: 'feature-v2',
        baseBranch: 'feature',
      })
      await renameBranch('sess-a', 'canvas-x', 'feature', 'experimental')
      const state = await loadCanvasBranches('sess-a', 'canvas-x')
      const v2 = state.branches.find((b) => b.name === 'feature-v2')
      expect(v2?.baseBranch).toBe('experimental')
    })
  })

  // Every read-modify-write mutator funnels through mutateCanvasBranches,
  // which is documented to take the same per-workspace write lock that
  // file-gc's collect-then-unlink pass holds — the read and the write must
  // happen inside a SINGLE lock acquisition, otherwise a GC pass can
  // interleave between them. These tests assert the lock coverage directly
  // (by holding the workspace lock externally, the way file-gc does, and
  // checking the mutator blocks until it is released) rather than only via
  // the comment on mutateCanvasBranches — a regression that reintroduced an
  // unlocked read before the write would leave the mutator free to run
  // concurrently with the held lock and this test would catch that.
  describe('workspace write lock coverage', () => {
    async function holdLockUntil(
      workspaceId: string,
    ): Promise<{ release: () => void; held: Promise<void> }> {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const held = withWorkspaceWriteLock(workspaceId, () => gate)
      // Let the lock-acquisition microtask actually run before returning.
      await Promise.resolve()
      return { release, held }
    }

    it('createBranch waits for an externally held workspace lock before reading state', async () => {
      const { release, held } = await holdLockUntil('sess-lock-create')
      let settled = false
      const createPromise = createBranch('sess-lock-create', 'canvas', { name: 'feature' }).then(
        (r) => {
          settled = true
          return r
        },
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(settled).toBe(false)
      release()
      await held
      const result = await createPromise
      expect(settled).toBe(true)
      expect(result.name).toBe('feature')
    })

    it('deleteBranch waits for an externally held workspace lock before reading state', async () => {
      await createBranch('sess-lock-delete', 'canvas', { name: 'feature' })
      const { release, held } = await holdLockUntil('sess-lock-delete')
      let settled = false
      const deletePromise = deleteBranch('sess-lock-delete', 'canvas', 'feature').then((r) => {
        settled = true
        return r
      })
      await new Promise((r) => setTimeout(r, 20))
      expect(settled).toBe(false)
      release()
      await held
      const result = await deletePromise
      expect(settled).toBe(true)
      expect(result.ok).toBe(true)
    })

    it('setHead waits for an externally held workspace lock before reading state', async () => {
      await createBranch('sess-lock-sethead', 'canvas', { name: 'feature' })
      const { release, held } = await holdLockUntil('sess-lock-sethead')
      let settled = false
      const setHeadPromise = setHead('sess-lock-sethead', 'canvas', 'feature').then((r) => {
        settled = true
        return r
      })
      await new Promise((r) => setTimeout(r, 20))
      expect(settled).toBe(false)
      release()
      await held
      const result = await setHeadPromise
      expect(settled).toBe(true)
      expect(result.head).toBe('feature')
    })

    it('renameBranch waits for an externally held workspace lock before reading state', async () => {
      await createBranch('sess-lock-rename', 'canvas', { name: 'feature' })
      const { release, held } = await holdLockUntil('sess-lock-rename')
      let settled = false
      const renamePromise = renameBranch('sess-lock-rename', 'canvas', 'feature', 'renamed').then(
        (r) => {
          settled = true
          return r
        },
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(settled).toBe(false)
      release()
      await held
      const result = await renamePromise
      expect(settled).toBe(true)
      expect(result.name).toBe('renamed')
    })
  })
})
