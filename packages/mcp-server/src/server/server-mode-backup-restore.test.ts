import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// server-mode-backup-restore.ts only imports backup-restore.ts and
// server-mode-record.ts — neither pulls in config.js, so the deferral this
// used to be written as bought nothing.
import {
  BackupError,
  backupServerModeDataDir,
  restoreServerModeDataDir,
} from './server-mode-backup-restore.js'

async function makeRoots() {
  const root = await mkdtemp(join(tmpdir(), 'wb-sm-br-test-'))
  const src = join(root, 'src')
  const backup = join(root, 'backup')
  const target = join(root, 'target')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'whiteboard.db'), 'fake-db-bytes')
  return { root, src, backup, target }
}

describe('backupServerModeDataDir', () => {
  it('copies data dir wholesale, including server-mode.json', async () => {
    const { root, src, backup } = await makeRoots()
    try {
      writeFileSync(join(src, 'server-mode.json'), JSON.stringify({ schemaVersion: 1, pid: 999 }))
      await backupServerModeDataDir(src, backup, { allowedRoots: [root] })
      expect(existsSync(join(backup, 'whiteboard.db'))).toBe(true)
      expect(existsSync(join(backup, 'server-mode.json'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects source outside allowedRoots', async () => {
    const { root, src, backup } = await makeRoots()
    try {
      await expect(
        backupServerModeDataDir(src, backup, { allowedRoots: ['/nowhere'] }),
      ).rejects.toBeInstanceOf(BackupError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('restoreServerModeDataDir', () => {
  it('restores data and removes server-mode.json from target', async () => {
    const { root, src, backup, target } = await makeRoots()
    try {
      writeFileSync(join(src, 'server-mode.json'), JSON.stringify({ schemaVersion: 1, pid: 999 }))
      await backupServerModeDataDir(src, backup, { allowedRoots: [root] })
      await restoreServerModeDataDir(backup, target, { allowedRoots: [root] })
      expect(existsSync(join(target, 'whiteboard.db'))).toBe(true)
      expect(existsSync(join(target, 'server-mode.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('succeeds when backup contains no server-mode.json (ENOENT silenced)', async () => {
    const { root, src, backup, target } = await makeRoots()
    try {
      // No server-mode.json in src.
      await backupServerModeDataDir(src, backup, { allowedRoots: [root] })
      await expect(
        restoreServerModeDataDir(backup, target, { allowedRoots: [root] }),
      ).resolves.toBeUndefined()
      expect(existsSync(join(target, 'whiteboard.db'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects non-empty target directory', async () => {
    const { root, src, backup, target } = await makeRoots()
    try {
      await backupServerModeDataDir(src, backup, { allowedRoots: [root] })
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'stale.db'), 'old-data')
      await expect(
        restoreServerModeDataDir(backup, target, { allowedRoots: [root] }),
      ).rejects.toBeInstanceOf(BackupError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects target outside allowedRoots', async () => {
    const { root, src, backup, target } = await makeRoots()
    try {
      await backupServerModeDataDir(src, backup, { allowedRoots: [root] })
      await expect(
        restoreServerModeDataDir(backup, target, { allowedRoots: ['/nowhere'] }),
      ).rejects.toBeInstanceOf(BackupError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('error message does not echo raw filesystem paths', async () => {
    const { root, src, backup, target } = await makeRoots()
    try {
      await backupServerModeDataDir(src, backup, { allowedRoots: [root] })
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'stale.db'), 'old-data')
      const err = await restoreServerModeDataDir(backup, target, {
        allowedRoots: [root],
      }).catch((e) => e)
      expect(err).toBeInstanceOf(BackupError)
      expect(err.message).not.toContain(target)
      expect(err.message).not.toContain(backup)
      expect(err.message).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('non-leak: BackupError from path traversal does not echo the rejected path', async () => {
    const { root, src, backup, target } = await makeRoots()
    try {
      await backupServerModeDataDir(src, backup, { allowedRoots: [root] })
      const err = await restoreServerModeDataDir(backup, target, {
        allowedRoots: ['/secret-allowed-root'],
      }).catch((e) => e)
      expect(err).toBeInstanceOf(BackupError)
      expect(err.message).not.toContain(target)
      expect(err.message).not.toContain(backup)
      expect(err.message).not.toContain(root)
      // Must not leak the allowed root either.
      expect(err.message).not.toContain('/secret-allowed-root')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
