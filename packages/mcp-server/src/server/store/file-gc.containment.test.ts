import { mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceDir, workspaceFilesDir, workspacesRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

// The containment gate every purge runs before listing a files dir, whoever
// called it. The ancestor case matters most — a symlinked workspaces root
// leaves every workspace dir lstat()ing as a plain directory, so realpath is
// the only check that sees it. The files/-child case is file-gc.test.ts's.

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

// A one-off, path-scoped rejection from lstat/realpath, for the gate's generic
// (non-ENOENT) failure branches, which a real filesystem cannot reliably
// produce (root bypasses permission checks, and many CI containers run as
// root). Every other path falls through to the real implementation.
const { fsFailureOverrides } = vi.hoisted(() => ({
  fsFailureOverrides: {
    lstat: null as null | { path: string; err: unknown },
    realpath: null as null | { path: string; err: unknown },
  },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      const override = fsFailureOverrides.lstat
      if (override && path === override.path) return Promise.reject(override.err)
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest)
    },
    realpath: (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
      const override = fsFailureOverrides.realpath
      if (override && path === override.path) return Promise.reject(override.err)
      return (actual.realpath as (...args: unknown[]) => unknown)(path, ...rest)
    },
  }
})

const { purgeDanglingFiles } = await import('./file-gc.js')
const { createFileGcSweeper } = await import('./file-gc-sweeper.js')
const { FileVersionStore } = await import('./version-store.js')
const { captureLogsForTests } = await import('../log.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { saveDocument } = await import('./document-store.js')
const { makeSpatialDocWithImage } = await import('../../shared/test-utils/spatial-doc.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-containment-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})

afterEach(async () => {
  fsFailureOverrides.lstat = null
  fsFailureOverrides.realpath = null
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** An image upload aged past the grace window, so only the gate can keep it. */
async function seedAgedImage(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), Buffer.alloc(10, 7))
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(join(dir, name), past, past)
}

function purge(workspaceId: string) {
  return purgeDanglingFiles(workspaceId, { versionStore: new FileVersionStore() })
}

const refusal = (workspaceId: string) => ({ name: 'FilesDirNotContainedError', workspaceId })

describe('file-GC containment gate: a symlink out of the data dir', () => {
  it('refuses when the workspaces root itself points outside the data dir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-gc-root-outside-'))
    try {
      const outsideFiles = join(outsideDir, '01WN90N8VTSGHKJJ1T928ZSS28', 'files')
      await seedAgedImage(outsideFiles, 'secret.png')
      // An ANCESTOR of the workspace dir is the symlink, so the workspace dir
      // itself lstat()s as a plain directory with a real files/ child: only
      // realpath can tell that it lives outside the data dir.
      await mkdir(join(wsRoot(), '..'), { recursive: true })
      await symlink(outsideDir, wsRoot(), 'dir')

      await expect(purge('01WN90N8VTSGHKJJ1T928ZSS28')).rejects.toMatchObject(
        refusal('01WN90N8VTSGHKJJ1T928ZSS28'),
      )
      expect(await readdir(outsideFiles)).toEqual(['secret.png'])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses when the workspace directory is a symlink escaping the data dir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-gc-dir-outside-'))
    try {
      await seedAgedImage(join(outsideDir, 'files'), 'secret.png')
      await mkdir(wsRoot(), { recursive: true })
      await symlink(outsideDir, wsDir('01CJN7B36KYG3GW3Y5HQ34PSND'), 'dir')

      await expect(purge('01CJN7B36KYG3GW3Y5HQ34PSND')).rejects.toMatchObject(
        refusal('01CJN7B36KYG3GW3Y5HQ34PSND'),
      )
      expect(await readdir(join(outsideDir, 'files'))).toEqual(['secret.png'])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses a sibling directory that merely shares the data dir as a prefix', async () => {
    // `<dataDir>-old` starts with `<dataDir>` as a string, so a prefix test
    // without the separator would read it as inside.
    const sibling = `${tempDir}-old`
    try {
      const siblingFiles = join(sibling, '015E6389CGYFJCDBG0ZBPKKTC6', 'files')
      await seedAgedImage(siblingFiles, 'secret.png')
      await mkdir(join(wsRoot(), '..'), { recursive: true })
      await symlink(sibling, wsRoot(), 'dir')

      await expect(purge('015E6389CGYFJCDBG0ZBPKKTC6')).rejects.toMatchObject(
        refusal('015E6389CGYFJCDBG0ZBPKKTC6'),
      )
      expect(await readdir(siblingFiles)).toEqual(['secret.png'])
    } finally {
      await rm(sibling, { recursive: true, force: true })
    }
  })

  it('still purges a contained workspace beside a refused one', async () => {
    const filesDir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, '011S9E3T39BCZQ1V287J9H2F9V')
    await seedAgedImage(filesDir, 'orphan.png')

    await expect(purge('011S9E3T39BCZQ1V287J9H2F9V')).resolves.toEqual({
      purgedCount: 1,
      purgedBytes: 10,
    })
    expect(await readdir(filesDir)).toEqual([])
  })
})

describe('file-GC containment gate: a files dir re-pointed during the reference scan', () => {
  it('refuses to unlink through a files/ swapped for an outside symlink mid-scan', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-gc-midscan-outside-'))
    try {
      const filesDir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, '019E5XSRRM0WA2FYT5NMQVGSRN')
      await saveDocument('019E5XSRRM0WA2FYT5NMQVGSRN', 'page', makeSpatialDocWithImage('kept-ref'))
      await seedAgedImage(filesDir, 'orphan.png')
      await seedAgedImage(outsideDir, 'orphan.png')
      let swapped = false
      // The scan reads versions after the gate has passed and the listing is
      // taken, which is exactly when a re-point would land.
      const versionStore = {
        listIdsByDocument: async () => {
          if (!swapped) {
            swapped = true
            await rename(filesDir, `${filesDir}.moved`)
            await symlink(outsideDir, filesDir, 'dir')
          }
          return []
        },
        openCheckouts: async () => ({
          load: async () => {
            throw new Error('no versions were listed')
          },
        }),
      }

      await expect(
        purgeDanglingFiles('019E5XSRRM0WA2FYT5NMQVGSRN', { versionStore }),
      ).rejects.toMatchObject(refusal('019E5XSRRM0WA2FYT5NMQVGSRN'))
      expect(swapped).toBe(true)
      expect(await readdir(outsideDir)).toEqual(['orphan.png'])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('file-GC containment gate: a check that cannot complete fails closed', () => {
  it('refuses and logs the error when lstat rejects with a permission error', async () => {
    const cap = captureLogsForTests('debug')
    try {
      await seedAgedImage(
        workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, '014JSD6Q5F9ERBE7DV1Z5YQF86'),
        'a.png',
      )
      const boom = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      fsFailureOverrides.lstat = { path: wsDir('014JSD6Q5F9ERBE7DV1Z5YQF86'), err: boom }

      await expect(purge('014JSD6Q5F9ERBE7DV1Z5YQF86')).rejects.toMatchObject(
        refusal('014JSD6Q5F9ERBE7DV1Z5YQF86'),
      )
      const warned = cap.records.filter((r) => r.scope === 'file-gc' && r.level === 'warning')
      expect(
        warned.some(
          (r) =>
            r.data?.workspaceId === '014JSD6Q5F9ERBE7DV1Z5YQF86' &&
            String((r.data?.err as Error | undefined)?.message).includes('EACCES'),
        ),
      ).toBe(true)
    } finally {
      cap.restore()
    }
  })

  it('refuses and logs the error when realpath rejects with a non-ENOENT error', async () => {
    const cap = captureLogsForTests('debug')
    try {
      await seedAgedImage(
        workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, '012B4NQ51JB25BXVBZTZ2KWQBS'),
        'a.png',
      )
      const boom = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
      fsFailureOverrides.realpath = { path: wsDir('012B4NQ51JB25BXVBZTZ2KWQBS'), err: boom }

      await expect(purge('012B4NQ51JB25BXVBZTZ2KWQBS')).rejects.toMatchObject(
        refusal('012B4NQ51JB25BXVBZTZ2KWQBS'),
      )
      const warned = cap.records.filter((r) => r.scope === 'file-gc' && r.level === 'warning')
      expect(
        warned.some(
          (r) =>
            r.data?.workspaceId === '012B4NQ51JB25BXVBZTZ2KWQBS' &&
            String((r.data?.err as Error | undefined)?.message).includes('EIO'),
        ),
      ).toBe(true)
    } finally {
      cap.restore()
    }
  })
})

describe('file-GC containment gate: what the sweeper does with a refusal', () => {
  it('skips a refused workspace as a warning, not a sweep failure, and keeps going', async () => {
    const cap = captureLogsForTests('debug')
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-gc-sweep-outside-'))
    try {
      await seedAgedImage(join(outsideDir, 'files'), 'secret.png')
      await mkdir(wsRoot(), { recursive: true })
      await symlink(outsideDir, wsDir('010917NDNNN70DT22A8Y4134C1'), 'dir')
      const plainFiles = workspaceFilesDir(
        tempDir,
        SELF_HOST_TENANT_ID,
        '01QWEG7Q1FN2AXC8SSS2T6J0F7',
      )
      await seedAgedImage(plainFiles, 'orphan.png')

      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [],
        discoverFsWorkspaces: async () => [
          '010917NDNNN70DT22A8Y4134C1',
          '01QWEG7Q1FN2AXC8SSS2T6J0F7',
        ],
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(await readdir(join(outsideDir, 'files'))).toEqual(['secret.png'])
      expect(await readdir(plainFiles)).toEqual([])
      const forRefused = cap.records.filter(
        (r) => r.data?.workspaceId === '010917NDNNN70DT22A8Y4134C1',
      )
      expect(forRefused.some((r) => r.scope === 'file-gc' && r.level === 'warning')).toBe(true)
      expect(forRefused.filter((r) => r.level === 'error')).toEqual([])
    } finally {
      cap.restore()
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
