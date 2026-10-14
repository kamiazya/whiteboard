import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performBackup } from './backup-pass.js'
import { closeDb, getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'

// What the pass did to the disk, in order: which path a handle was synced for,
// and which path each rename moved. Records only; every call is real.
const fsEvents = vi.hoisted(() => ({ log: [] as string[] }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      const path = String(args[0])
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync()
        fsEvents.log.push(`sync ${path}`)
      }
      return handle
    }) as typeof real.open,
    rename: (async (...args: Parameters<typeof real.rename>) => {
      await real.rename(...args)
      fsEvents.log.push(`rename ${String(args[0])}`)
    }) as typeof real.rename,
  }
})

let root: string
let dataDir: string
let backupRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-seal-sync-'))
  dataDir = join(root, 'data')
  backupRoot = join(root, 'backups')
  await mkdir(dataDir, { recursive: true })
  await prepareDataDir(dataDir)
  await getDb(dataDir)
})
afterEach(async () => {
  fsEvents.log = []
  await closeDb(dataDir)
  await rm(root, { recursive: true, force: true })
})

const NIGHT = '2026-03-04T00-00-00.000Z'

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)))
}

/**
 * The seal renames a DIRECTORY, and a filesystem need not order the data of
 * the files inside it before that rename — so without a sync, a crash shortly
 * after a pass can leave a directory with a backup's name holding a
 * zero-length manifest or settings file. Restore then refuses the newest
 * backup, the mirror's collector stands down while it is retained, and
 * retention counts it against a usable one.
 */
describe('the backup seal is durable', () => {
  it('syncs every file it holds and the staging dir before the rename', async () => {
    const outputDir = join(backupRoot, NIGHT)
    const outcome = await performBackup({ dataDir, outputDir, mirrorRoot: backupRoot })
    expect(outcome.kind).toBe('ok')

    const staging = `${outputDir}.incomplete`
    const sealed = fsEvents.log.indexOf(`rename ${staging}`)
    expect(sealed).toBeGreaterThan(-1)
    const before = fsEvents.log.slice(0, sealed)

    const files = await filesUnder(outputDir)
    // The subject is present: a backup always carries a manifest and rows.
    expect(files).toEqual(expect.arrayContaining(['blobs.json', 'whiteboard.db']))
    for (const file of files) {
      expect(before).toContain(`sync ${join(staging, file)}`)
    }
    expect(before).toContain(`sync ${staging}`)
  })

  it('syncs the parent directory after the rename, so the seal survives', async () => {
    const outputDir = join(backupRoot, NIGHT)
    await performBackup({ dataDir, outputDir, mirrorRoot: backupRoot })

    const sealed = fsEvents.log.indexOf(`rename ${outputDir}.incomplete`)
    expect(sealed).toBeGreaterThan(-1)
    expect(fsEvents.log.slice(sealed + 1)).toContain(`sync ${backupRoot}`)
  })
})
