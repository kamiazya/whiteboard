import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceDir, workspacesRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

// The containment gate the sweep runs before every purge, held from both
// sources of ids: a DB row and a directory found on disk. The ancestor cases
// matter most — a symlinked workspaces root leaves every workspace dir
// lstat()ing as a plain directory, so realpath is the only check that sees it.

let tempDir: string

const wsRoot = (): string => workspacesRoot(tempDir, SELF_HOST_TENANT_ID)
const wsDir = (id: string): string => workspaceDir(tempDir, SELF_HOST_TENANT_ID, id)

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createFileGcSweeper } = await import('./file-gc-sweeper.js')
const { captureLogsForTests } = await import('../log.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-containment-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('file-GC containment gate: an ancestor symlink out of the data dir', () => {
  it('skips a DB-listed workspace when the workspaces root itself points outside the data dir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweeper-root-outside-'))
    try {
      await mkdir(join(outsideDir, 'evil_root_ws', 'files'), { recursive: true })
      // An ANCESTOR of the workspace dir is the symlink, so the workspace dir
      // itself lstat()s as a plain directory: only the realpath containment
      // check can see that it resolves outside the data dir.
      await mkdir(join(wsRoot(), '..'), { recursive: true })
      await symlink(outsideDir, wsRoot(), 'dir')

      const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [{ workspaceId: 'evil_root_ws' }],
        discoverFsWorkspaces: async () => [],
        purge,
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(purge).not.toHaveBeenCalled()
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('skips a discovered workspace when the workspaces root itself points outside the data dir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweeper-fs-root-outside-'))
    try {
      const outsideFilesDir = join(outsideDir, 'evil_fs_root_ws', 'files')
      await mkdir(outsideFilesDir, { recursive: true })
      await writeFile(join(outsideFilesDir, 'secret.png'), Buffer.alloc(10, 8))
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await utimes(join(outsideFilesDir, 'secret.png'), past, past)
      // Discovery lists the workspace THROUGH the symlinked root, and the
      // workspace dir lstat()s as a plain directory with a real files/ child:
      // only realpath containment can tell that it lives outside the data dir.
      await mkdir(join(wsRoot(), '..'), { recursive: true })
      await symlink(outsideDir, wsRoot(), 'dir')

      const sweeper = createFileGcSweeper({ listWorkspaces: async () => [] })
      await sweeper.tick()
      await sweeper.stop()

      const remaining = await readdir(outsideFilesDir)
      expect(remaining).toEqual(['secret.png'])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('file-GC containment gate: what a refusal logs', () => {
  it('logs a refused filesystem-discovered workspace without calling it a DB workspace', async () => {
    const cap = captureLogsForTests('debug')
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweeper-fs-log-outside-'))
    try {
      await mkdir(wsRoot(), { recursive: true })
      await symlink(outsideDir, wsDir('ws_fs_refused'), 'dir')

      const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [],
        discoverFsWorkspaces: async () => ['ws_fs_refused'],
        purge,
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(purge).not.toHaveBeenCalled()
      const refusals = cap.records.filter(
        (r) =>
          r.scope === 'file-gc-sweeper' &&
          r.level === 'warning' &&
          r.data?.workspaceId === 'ws_fs_refused',
      )
      expect(refusals.length).toBeGreaterThan(0)
      for (const r of refusals) expect(r.msg).not.toMatch(/\bDB\b/)
    } finally {
      cap.restore()
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
