import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../shared/sha256.js'
import { BackupError, backupDataDir, restoreDataDir } from './backup-restore.js'
import { BackupManifestUnusableError } from './store/backup-blob-mirror.js'

let root: string
let backup: string
let target: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-restore-refusals-'))
  backup = join(root, 'backup')
  target = join(root, 'target')
  await mkdir(backup, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const options = () => ({ allowedRoots: [root] })

async function writeManifest(manifest: unknown): Promise<void> {
  await writeFile(join(backup, 'blobs.json'), JSON.stringify(manifest))
}

/** Put bytes in the backup's own mirror, where a manifest naming their digest finds them. */
async function mirrorBlob(contents: string): Promise<string> {
  const digest = sha256Hex(Buffer.from(contents))
  await mkdir(join(backup, 'blobs', digest.slice(0, 2)), { recursive: true })
  await writeFile(join(backup, 'blobs', digest.slice(0, 2), digest.slice(2)), contents)
  return digest
}

describe('a backup into a directory that already holds something', () => {
  it('refuses a non-empty backup directory and leaves what is there as it was', async () => {
    const src = join(root, 'src')
    await mkdir(src)
    await writeFile(join(src, 'data.txt'), 'rows')
    await mkdir(join(root, 'out'))
    await writeFile(join(root, 'out', 'stale.txt'), 'from an earlier backup')

    await expect(backupDataDir(src, join(root, 'out'), options())).rejects.toThrow(
      'Backup directory is not empty.',
    )
    expect(await readdir(join(root, 'out'))).toEqual(['stale.txt'])
  })
})

// A socket is how a non-regular entry is made without a native helper; the
// platform without them has no such entry to refuse.
describe.skipIf(process.platform === 'win32')('a tree holding a non-regular entry', () => {
  async function withSocketIn(dir: string): Promise<() => Promise<void>> {
    const server = createServer()
    await new Promise<void>((resolveListening, reject) => {
      server.once('error', reject)
      server.listen(join(dir, 'daemon.sock'), resolveListening)
    })
    return () => new Promise<void>((resolveClosed) => server.close(() => resolveClosed()))
  }

  it('is refused as a backup source, and nothing is copied', async () => {
    const src = join(root, 'src')
    await mkdir(src)
    await writeFile(join(src, 'data.txt'), 'rows')
    const close = await withSocketIn(src)
    try {
      await expect(backupDataDir(src, join(root, 'out'), options())).rejects.toThrow(
        /non-regular entry/,
      )
      expect(await readdir(root)).not.toContain('out')
    } finally {
      await close()
    }
  })

  it('is refused as a backup to restore, and nothing is restored', async () => {
    await writeFile(join(backup, 'data.txt'), 'rows')
    const close = await withSocketIn(backup)
    try {
      const refusal = restoreDataDir(backup, target, options())
      await expect(refusal).rejects.toBeInstanceOf(BackupError)
      await expect(refusal).rejects.toThrow(/non-regular entry/)
      expect(await readdir(root)).not.toContain('target')
    } finally {
      await close()
    }
  })
})

describe('restoring a manifest that names blobs', () => {
  it('refuses when the mirror lacks a blob it names, before putting anything in the target', async () => {
    const present = await mirrorBlob('here')
    const absent = sha256Hex(Buffer.from('never mirrored'))
    await writeManifest({
      schemaVersion: 3,
      mirror: 'self',
      tenants: { 'self-host': { blobs: [present, absent], files: {} } },
    })

    const refusal = restoreDataDir(backup, target, options())
    await expect(refusal).rejects.toBeInstanceOf(BackupError)
    await expect(refusal).rejects.toThrow('refers to 1 blob(s) the mirror does not hold')
    // The blob the mirror did hold is not half-restored either.
    expect(await readdir(join(target, 'tenants')).catch(() => [])).toEqual([])
  })

  it('puts back what the mirror holds, and leaves out the mirror stores themselves', async () => {
    const digest = await mirrorBlob('held')
    await writeManifest({
      schemaVersion: 3,
      mirror: 'self',
      tenants: { 'self-host': { blobs: [digest], files: {} } },
    })

    await restoreDataDir(backup, target, options())

    expect(
      await readFile(
        join(target, 'tenants', 'self-host', 'blobs', digest.slice(0, 2), digest.slice(2)),
        'utf8',
      ),
    ).toBe('held')
    expect(await readdir(target)).not.toContain('blobs')
  })

  it('keeps a top-level entry that only shares a name prefix with a mirror store', async () => {
    const digest = await mirrorBlob('held')
    await writeManifest({
      schemaVersion: 3,
      mirror: 'self',
      tenants: { 'self-host': { blobs: [digest], files: {} } },
    })
    await writeFile(join(backup, 'blobs-notes.txt'), 'an operator note')
    await writeFile(join(backup, 'files-notes.txt'), 'another')

    await restoreDataDir(backup, target, options())

    expect((await readdir(target)).sort()).toEqual([
      'blobs-notes.txt',
      'blobs.json',
      'files-notes.txt',
      'tenants',
    ])
  })

  it('refuses rather than overwrite a blob the copied tree already holds', async () => {
    const digest = await mirrorBlob('from the mirror')
    await writeManifest({
      schemaVersion: 3,
      mirror: 'self',
      tenants: { 'self-host': { blobs: [digest], files: {} } },
    })
    const occupied = join(backup, 'tenants', 'self-host', 'blobs', digest.slice(0, 2))
    await mkdir(occupied, { recursive: true })
    await writeFile(join(occupied, digest.slice(2)), 'already here')

    await expect(restoreDataDir(backup, target, options())).rejects.toThrow()
    expect(
      await readFile(
        join(target, 'tenants', 'self-host', 'blobs', digest.slice(0, 2), digest.slice(2)),
        'utf8',
      ),
    ).toBe('already here')
  })
})

describe('restoring a backup whose manifest cannot be used', () => {
  it('refuses a manifest of a version this build does not know, instead of reading it as a backup from before the mirror', async () => {
    await writeFile(join(backup, 'data.txt'), 'rows')
    await writeManifest({ schemaVersion: 4, mirror: 'self', tenants: {} })

    await expect(restoreDataDir(backup, target, options())).rejects.toBeInstanceOf(
      BackupManifestUnusableError,
    )
    expect(await readdir(root)).not.toContain('target')
  })

  it('refuses a manifest that is there but cannot be read as a file', async () => {
    await writeFile(join(backup, 'data.txt'), 'rows')
    await mkdir(join(backup, 'blobs.json'))

    await expect(restoreDataDir(backup, target, options())).rejects.toBeInstanceOf(
      BackupManifestUnusableError,
    )
    expect(await readdir(root)).not.toContain('target')
  })
})
