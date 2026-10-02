import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../shared/sha256.js'
import { restoreDataDir } from './backup-restore.js'

/**
 * A backup is an artifact somebody else may have produced or moved, and its
 * manifest is the one input of a restore that still NAMES destination paths.
 * Everything a manifest says must land under `<target>/tenants/<tenant>/blobs`,
 * whatever the strings in it are.
 */
let root: string
let backup: string
let target: string
const payload = Buffer.from('attacker-controlled')
const digest = sha256Hex(payload)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-hostile-manifest-'))
  backup = join(root, 'data', 'backup')
  target = join(root, 'data', 'target')
  await mkdir(join(backup, 'files', digest.slice(0, 2)), { recursive: true })
  await writeFile(join(backup, 'files', digest.slice(0, 2), digest.slice(2)), payload)
  await mkdir(join(backup, 'blobs', digest.slice(0, 2)), { recursive: true })
  await writeFile(join(backup, 'blobs', digest.slice(0, 2), digest.slice(2)), payload)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeManifest(tenants: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(backup, 'blobs.json'),
    JSON.stringify({ schemaVersion: 3, mirror: 'self', tenants }),
  )
}

/** Every file under `dir`, relative to it, so a stray write anywhere shows. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort()
}

/** The tree around the target that a restore must leave exactly as it found it. */
async function outsideTarget(): Promise<string[]> {
  return (await filesUnder(root)).filter((path) => !path.startsWith(join('data', 'target')))
}

describe('restoring a backup whose manifest names hostile paths', () => {
  it('puts an ordinary named file under the tenant blobs directory', async () => {
    await writeManifest({ 'self-host': { blobs: [], files: { 'thumbs/a.png': digest } } })
    await restoreDataDir(backup, target, { allowedRoots: [root] })
    expect(
      await readFile(join(target, 'tenants', 'self-host', 'blobs', 'thumbs', 'a.png'), 'utf8'),
    ).toBe('attacker-controlled')
  })

  it.each([
    ['climbs out of the data directory', `${'../'.repeat(4)}escaped.txt`],
    ['climbs and comes back', 'thumbs/../../escaped.txt'],
    ['is absolute', '/escaped.txt'],
    ['has an empty segment', 'thumbs//a.png'],
    ['has a dot segment', 'thumbs/./a.png'],
    ['uses a backslash', 'thumbs\\a.png'],
    ['is empty', ''],
    ['is a dot', '.'],
  ])('refuses a files key that %s and writes nothing', async (_why, key) => {
    await writeManifest({ 'self-host': { blobs: [], files: { [key]: digest } } })
    const before = await outsideTarget()
    await expect(restoreDataDir(backup, target, { allowedRoots: [root] })).rejects.toThrow()
    expect(await outsideTarget()).toEqual(before)
    expect(await filesUnder(join(target, 'tenants')).catch(() => [])).toEqual([])
  })

  it.each([
    ['climbs out of the data directory', '../../../outside'],
    ['is the parent directory', '..'],
    ['is the current directory', '.'],
    ['is empty', ''],
    ['holds a separator', 'a/b'],
    ['holds a backslash', 'a\\b'],
  ])('refuses a tenant id that %s and writes nothing', async (_why, tenantId) => {
    await writeManifest({ [tenantId]: { blobs: [digest], files: {} } })
    const before = await outsideTarget()
    await expect(restoreDataDir(backup, target, { allowedRoots: [root] })).rejects.toThrow()
    expect(await outsideTarget()).toEqual(before)
    expect(await filesUnder(target).catch(() => [])).toEqual([])
  })
})
