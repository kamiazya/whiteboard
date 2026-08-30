import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restoreDataDir } from '../backup-restore.js'
import { performBackup } from './backup-pass.js'
import { closeDb, getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'

let root: string
let dataDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-mirror-trip-'))
  dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await prepareDataDir(dataDir)
  await getDb(dataDir)
})
afterEach(async () => {
  await closeDb(dataDir)
  await rm(root, { recursive: true, force: true })
})

async function putBlob(contents: string): Promise<string> {
  const digest = createHash('sha256').update(contents).digest('hex')
  const dir = join(dataDir, 'blobs', digest.slice(0, 2))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, digest.slice(2)), contents)
  return digest
}

async function putThumbnail(version: string, contents: string): Promise<void> {
  const dir = join(dataDir, 'blobs', '01JWORKSPACE00000000000000', 'versions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${version}.png`), contents)
}

async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function restoreInto(backupDir: string): Promise<string> {
  const target = join(root, `restored-${Math.random().toString(36).slice(2)}`)
  await restoreDataDir(backupDir, target, { allowedRoots: [root] })
  return target
}

/**
 * The round trip is what makes the mirror safe to adopt.
 *
 * A backup that is smaller is not an improvement if what it holds cannot be
 * put back — and the failure would be silent, since every step of a backup
 * that forgot its blobs still reports success. So the assertion is not "the
 * manifest is right", it is "the bytes come back".
 */
describe('a mirrored backup restores what it captured', () => {
  it('brings back blobs and thumbnails from the shared mirror', async () => {
    const digest = await putBlob('an uploaded image')
    await putThumbnail('v1', 'a version thumbnail')

    const backupRoot = join(root, 'backups')
    const backupDir = join(backupRoot, '2026-03-04T05-06-07.000Z')
    const outcome = await performBackup({ dataDir, outputDir: backupDir, mirrorRoot: backupRoot })
    expect(outcome.kind).toBe('ok')

    // Discriminating, and the reason these tests are not merely a round trip:
    // the bytes come back under the OLD whole-tree copy too. What says the
    // mirror is doing the work is that the backup directory itself does not
    // carry them.
    expect(await pathExists(join(backupDir, 'blobs'))).toBe(false)
    expect(await pathExists(join(backupRoot, 'blobs', digest.slice(0, 2), digest.slice(2)))).toBe(
      true,
    )

    const restored = await restoreInto(backupDir)
    expect(
      await readFile(join(restored, 'blobs', digest.slice(0, 2), digest.slice(2)), 'utf8'),
    ).toBe('an uploaded image')
    expect(
      await readFile(
        join(restored, 'blobs', '01JWORKSPACE00000000000000', 'versions', 'v1.png'),
        'utf8',
      ),
    ).toBe('a version thumbnail')
  })

  /**
   * The affordance the shared mirror would otherwise take away: an operator
   * who runs `whiteboard server backup --output-dir=X` gets a directory they
   * can copy somewhere and restore from on its own. Only the SCHEDULE shares
   * a mirror between backups, and that is the only place sharing buys
   * anything — a one-off has nothing to share with.
   */
  it('keeps a one-off backup self-contained', async () => {
    const digest = await putBlob('a one-off')
    const backupDir = join(root, 'one-off')
    expect((await performBackup({ dataDir, outputDir: backupDir })).kind).toBe('ok')

    // Inside the backup, not beside it — which is what lets it be carried.
    expect(await pathExists(join(backupDir, 'blobs', digest.slice(0, 2), digest.slice(2)))).toBe(
      true,
    )

    // Moved away from where it was taken, with nothing beside it.
    const moved = join(root, 'carried', 'elsewhere')
    await mkdir(join(root, 'carried'), { recursive: true })
    const { rename } = await import('node:fs/promises')
    await rename(backupDir, moved)

    const restored = await restoreInto(moved)
    expect(
      await readFile(join(restored, 'blobs', digest.slice(0, 2), digest.slice(2)), 'utf8'),
    ).toBe('a one-off')
  })

  /**
   * Two nights, one blob added on the second. The second backup must restore
   * BOTH — the blob it added and the one the first night mirrored — which is
   * the whole point of a shared mirror and the thing a per-backup copy got
   * for free.
   */
  it('restores a blob an earlier pass mirrored', async () => {
    const first = await putBlob('from the first night')
    const backupRoot = join(root, 'backups')
    await performBackup({
      dataDir,
      outputDir: join(backupRoot, '2026-03-04T00-00-00.000Z'),
      mirrorRoot: backupRoot,
    })

    const second = await putBlob('from the second night')
    const night2 = join(backupRoot, '2026-03-05T00-00-00.000Z')
    await performBackup({ dataDir, outputDir: night2, mirrorRoot: backupRoot })
    expect(await pathExists(join(night2, 'blobs'))).toBe(false)

    const restored = await restoreInto(night2)
    for (const [digest, contents] of [
      [first, 'from the first night'],
      [second, 'from the second night'],
    ] as const) {
      expect(
        await readFile(join(restored, 'blobs', digest.slice(0, 2), digest.slice(2)), 'utf8'),
      ).toBe(contents)
    }
  })

  /**
   * A backup whose mirror is not where its manifest says refuses rather than
   * restoring a data directory with holes in it. `snapshotIsRestorable` is
   * the predicate; this is the moment ADR-0021 decision 6 says to call it,
   * and a restore is when an operator most wants it checked.
   */
  it('refuses when the mirror cannot supply everything the backup needs', async () => {
    const digest = await putBlob('will go missing')
    const backupRoot = join(root, 'backups')
    const backupDir = join(backupRoot, '2026-03-04T00-00-00.000Z')
    await performBackup({ dataDir, outputDir: backupDir, mirrorRoot: backupRoot })

    await rm(join(backupRoot, 'blobs', digest.slice(0, 2), digest.slice(2)), { force: true })

    await expect(restoreInto(backupDir)).rejects.toThrow(/blob/i)
  })
})
