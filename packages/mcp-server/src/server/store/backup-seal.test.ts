import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { performBackup } from './backup-pass.js'
import { closeDb, getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { snapshotDatabaseInto } from './db/snapshot.js'

let root: string
let dataDir: string
let backupRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-seal-'))
  dataDir = join(root, 'data')
  backupRoot = join(root, 'backups')
  await mkdir(dataDir, { recursive: true })
  await prepareDataDir(dataDir)
  await getDb(dataDir)
})
afterEach(async () => {
  await closeDb(dataDir)
  await rm(root, { recursive: true, force: true })
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const NIGHT = '2026-03-04T00-00-00.000Z'

/**
 * ADR-0021 decision 6, near end: a snapshot is not OFFERED until every store
 * has finished with it.
 *
 * In this shape "offered" is concrete — it is appearing under a backup name.
 * A pass writes the tree, then the rows, then the blob manifest, and until it
 * has done all three what is on disk is not a backup. Before this, a pass
 * that died partway left a directory whose NAME says backup and whose
 * contents are a fragment: measured, a failing snapshot left
 * `['storage.json']` sitting at the backup path.
 *
 * Three things then read it as real, and all three are silent. Retention
 * counts it, so a real backup is pushed out of the window to make room for a
 * fragment. The mirror's collector finds it manifest-less and refuses to
 * collect anything, ever again. And restore treats a missing manifest as "a
 * backup from before the mirror" and restores a data directory with no rows
 * and no blobs in it, reporting success.
 *
 * The fix is the one the mirror already uses for a single blob: write
 * somewhere else, then rename. Appearing and being complete become the same
 * event, so no reader ever has to ask whether what it found is finished.
 */
describe('a backup is not offered until it is complete', () => {
  it('leaves nothing at the backup path when the pass fails', async () => {
    const outcome = await performBackup({
      dataDir,
      outputDir: join(backupRoot, NIGHT),
      mirrorRoot: backupRoot,
      doSnapshot: async () => {
        throw new Error('killed partway')
      },
    })

    expect(outcome.kind).toBe('error')
    expect(await pathExists(join(backupRoot, NIGHT))).toBe(false)
  })

  /**
   * Not merely "cleaned up afterwards" — never present. A reader that looked
   * while the pass was still running would otherwise find the same fragment,
   * and retention and the collector run on a schedule of their own.
   */
  it('does not put the backup name in place until the last store is done', async () => {
    let visibleDuringSnapshot: boolean | null = null
    await performBackup({
      dataDir,
      outputDir: join(backupRoot, NIGHT),
      mirrorRoot: backupRoot,
      doSnapshot: async (dir, destPath) => {
        visibleDuringSnapshot = await pathExists(join(backupRoot, NIGHT))
        await snapshotDatabaseInto(dir, destPath)
      },
    })

    expect(visibleDuringSnapshot).toBe(false)
    expect(await pathExists(join(backupRoot, NIGHT))).toBe(true)
  })

  /**
   * And what IS left behind must not look like a backup to anything else. The
   * leader lease means only one pass runs at a time, so a staging directory
   * found on disk is always one an earlier pass abandoned — it is cleared
   * rather than colliding with the next attempt.
   */
  it('does not leave anything a later pass or retention mistakes for a backup', async () => {
    await performBackup({
      dataDir,
      outputDir: join(backupRoot, NIGHT),
      mirrorRoot: backupRoot,
      doSnapshot: async () => {
        throw new Error('killed partway')
      },
    })

    const left = (await readdir(backupRoot)).filter((name) => name !== 'blobs' && name !== 'files')
    expect(left).toEqual([])
  })

  /**
   * Each failure path separately, because each cleans up on its own line and
   * a test that only exercises one leaves the others unpinned — measured, the
   * snapshot path's cleanup is caught by the case above and the mirror's was
   * caught by nothing until this existed.
   */
  it('leaves nothing behind when the blob mirror is what fails', async () => {
    const outcome = await performBackup({
      dataDir,
      outputDir: join(backupRoot, NIGHT),
      mirrorRoot: backupRoot,
      doMirror: async () => {
        throw new Error('the mirror could not be written')
      },
    })

    expect(outcome.kind).toBe('error')
    const left = (await readdir(backupRoot)).filter((name) => name !== 'blobs' && name !== 'files')
    expect(left).toEqual([])
  })

  it('completes over a staging directory an earlier pass abandoned', async () => {
    // Whatever the staging name is, a directory already sitting there must not
    // stop the next attempt: `backupDataDir` refuses a non-empty destination,
    // so a leftover would wedge every future pass.
    await performBackup({
      dataDir,
      outputDir: join(backupRoot, NIGHT),
      mirrorRoot: backupRoot,
      doSnapshot: async () => {
        throw new Error('killed partway')
      },
    })
    // Plant one by hand too, in case the failed pass above cleaned up after
    // itself: a process that is killed outright does not get to.
    for (const name of await readdir(backupRoot)) {
      if (name === 'blobs' || name === 'files') continue
      await rm(join(backupRoot, name), { recursive: true, force: true })
    }
    await mkdir(join(backupRoot, `${NIGHT}.incomplete`), { recursive: true })
    await writeFile(join(backupRoot, `${NIGHT}.incomplete`, 'junk'), 'from a killed pass')

    const outcome = await performBackup({
      dataDir,
      outputDir: join(backupRoot, NIGHT),
      mirrorRoot: backupRoot,
    })

    expect(outcome.kind).toBe('ok')
    expect(await pathExists(join(backupRoot, NIGHT, 'blobs.json'))).toBe(true)
    expect(await pathExists(join(backupRoot, NIGHT, 'junk'))).toBe(false)
  })
})
