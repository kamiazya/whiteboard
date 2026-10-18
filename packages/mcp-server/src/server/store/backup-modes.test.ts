import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from '../../shared/test-utils/chmod-is-observable.js'
import { restoreDataDir } from '../backup-restore.js'
import { blobsRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { performBackup } from './backup-pass.js'
import { closeDb, getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { snapshotDatabaseInto } from './db/snapshot.js'

let root: string
let dataDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-backup-modes-'))
  dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await prepareDataDir(dataDir)
  await getDb(dataDir)
})
afterEach(async () => {
  await closeDb(dataDir)
  await rm(root, { recursive: true, force: true })
})

/** Written under the default umask, as a real data dir's files are. */
async function seedDataDir(): Promise<string> {
  const contents = 'an uploaded image'
  const digest = createHash('sha256').update(contents).digest('hex')
  const shard = join(blobsRoot(dataDir, SELF_HOST_TENANT_ID), digest.slice(0, 2))
  await mkdir(shard, { recursive: true })
  await writeFile(join(shard, digest.slice(2)), contents)
  const versions = join(blobsRoot(dataDir, SELF_HOST_TENANT_ID), '01JWORKSPACE00000000000000')
  await mkdir(versions, { recursive: true })
  await writeFile(join(versions, 'v1.png'), 'a version thumbnail')
  await writeFile(join(dataDir, 'notes.txt'), 'a file the tree copy carries')
  return digest
}

async function entriesUnder(dir: string): Promise<Array<{ path: string; mode: number }>> {
  const found: Array<{ path: string; mode: number }> = []
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const stat = await lstat(path)
    found.push({ path, mode: stat.mode & 0o777 })
    if (stat.isDirectory()) found.push(...(await entriesUnder(path)))
  }
  return found
}

/**
 * A backup holds every document and upload, and it is written where an
 * operator keeps backups — often a traversable dir, so a world-readable file
 * under it is one any local user can copy out.
 */
describe.skipIf(!CHMOD_IS_OBSERVABLE)('a backup is readable by its owner alone', () => {
  it.each([
    ['a mirror shared beside it', 'parent'],
    ['its mirror inside itself', 'self'],
  ] as const)('closes every dir and file it writes, with %s', async (_label, mirror) => {
    const digest = await seedDataDir()
    const backupRoot = join(root, 'backups')
    const outputDir = join(backupRoot, '2026-03-04T05-06-07.000Z')
    const outcome = await performBackup({
      dataDir,
      outputDir,
      mirrorRoot: mirror === 'parent' ? backupRoot : outputDir,
    })
    expect(outcome.kind).toBe('ok')

    const entries = await entriesUnder(backupRoot)
    // The database snapshot, the blob mirror, the copied file and the
    // manifest are all reached, so the walk cannot pass by finding nothing.
    expect(entries.some(({ path }) => path.endsWith('whiteboard.db'))).toBe(true)
    expect(entries.some(({ path }) => path.endsWith(digest.slice(2)))).toBe(true)
    expect(entries.some(({ path }) => path.endsWith('notes.txt'))).toBe(true)
    expect(entries.length).toBeGreaterThan(8)
    expect(entries.filter(({ mode }) => (mode & 0o077) !== 0)).toEqual([])
    expect((await lstat(backupRoot)).mode & 0o077).toBe(0)

    const target = join(root, 'restored')
    await restoreDataDir(outputDir, target, { allowedRoots: [root] })
    expect(await readFile(join(target, 'notes.txt'), 'utf8')).toBe('a file the tree copy carries')
  })

  // A mirror an earlier build wrote kept the umask's mode, and it holds every
  // upload a retained backup still names.
  it('closes a shared mirror an earlier pass left open', async () => {
    await seedDataDir()
    const backupRoot = join(root, 'backups')
    await mkdir(join(backupRoot, 'blobs'), { recursive: true })
    await chmod(join(backupRoot, 'blobs'), 0o755)
    const outcome = await performBackup({
      dataDir,
      outputDir: join(backupRoot, '2026-03-04T05-06-07.000Z'),
      mirrorRoot: backupRoot,
    })
    expect(outcome.kind).toBe('ok')
    expect((await lstat(join(backupRoot, 'blobs'))).mode & 0o777).toBe(0o700)
  })

  it('writes the database snapshot for its owner alone', async () => {
    const dest = join(root, 'snapshot', 'whiteboard.db')
    await snapshotDatabaseInto(dataDir, dest)
    expect((await lstat(dest)).mode & 0o777).toBe(0o600)
  })
})
