import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectMirroredBlobs } from './backup-mirror-retention.js'

let backupRoot: string

beforeEach(async () => {
  backupRoot = await mkdtemp(join(tmpdir(), 'wb-mirror-gc-'))
})
afterEach(async () => {
  await rm(backupRoot, { recursive: true, force: true })
})

function digestOf(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function mirrorBlob(contents: string): Promise<string> {
  const digest = digestOf(contents)
  await mkdir(join(backupRoot, 'blobs', digest.slice(0, 2)), { recursive: true })
  await writeFile(join(backupRoot, 'blobs', digest.slice(0, 2), digest.slice(2)), contents)
  return digest
}

async function mirrorFile(contents: string): Promise<string> {
  const digest = digestOf(contents)
  await mkdir(join(backupRoot, 'files', digest.slice(0, 2)), { recursive: true })
  await writeFile(join(backupRoot, 'files', digest.slice(0, 2), digest.slice(2)), contents)
  return digest
}

async function backupReferencing(
  name: string,
  blobs: readonly string[],
  files: Record<string, string> = {},
): Promise<void> {
  const dir = join(backupRoot, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'blobs.json'),
    JSON.stringify({ schemaVersion: 2, blobs, files, mirror: 'parent' }),
  )
}

async function mirroredDigests(store: 'blobs' | 'files'): Promise<string[]> {
  const found: string[] = []
  let shards: string[]
  try {
    shards = await readdir(join(backupRoot, store))
  } catch {
    return found
  }
  for (const shard of shards) {
    for (const rest of await readdir(join(backupRoot, store, shard))) found.push(`${shard}${rest}`)
  }
  return found.sort()
}

/**
 * ADR-0021 decision 6, far end: retention must not delete behind.
 *
 * The mirror is append-only, so this is the only thing that ever removes from
 * it — and what it may remove is governed by which backups are still RETAINED,
 * never by what the live data directory still references. A blob no document
 * uses any more is still needed by every retained backup taken while it was in
 * use, and `collectableFromBackup` is the predicate that says so. It has been
 * written and unreachable since; this is what calls it.
 */
describe('collecting from the blob mirror', () => {
  it('keeps what a retained backup still references', async () => {
    const kept = await mirrorBlob('still referenced')
    await backupReferencing('2026-03-04T00-00-00.000Z', [kept])

    await collectMirroredBlobs(backupRoot)

    expect(await mirroredDigests('blobs')).toEqual([kept])
  })

  /**
   * The blob the LIVE data directory has finished with, which is precisely
   * the one a liveness-driven collector would take. Nothing here reads the
   * data directory at all.
   */
  it('deletes what no retained backup references any more', async () => {
    const expired = await mirrorBlob('only the deleted backup wanted this')
    const current = await mirrorBlob('the current one')
    // The backup that referenced `expired` has already been pruned by the
    // scheduler's retention; only the newer one remains.
    await backupReferencing('2026-03-05T00-00-00.000Z', [current])

    const collected = await collectMirroredBlobs(backupRoot)

    expect(collected).toBe(1)
    expect(await mirroredDigests('blobs')).toEqual([current])
    expect(expired).not.toBe(current)
  })

  it('collects named files on the same rule', async () => {
    const kept = await mirrorFile('a thumbnail still wanted')
    const expired = await mirrorFile('a thumbnail nothing wants')
    await backupReferencing('2026-03-05T00-00-00.000Z', [], { 'ws/versions/v1.png': kept })

    await collectMirroredBlobs(backupRoot)

    expect(await mirroredDigests('files')).toEqual([kept])
    expect(expired).not.toBe(kept)
  })

  /**
   * The case that makes this dangerous to get wrong. A backup with no
   * manifest predates the mirror and says nothing about what it needs —
   * reading it as "references nothing" would collect the whole mirror out
   * from under every backup beside it. So an unreadable manifest stops the
   * pass rather than narrowing it.
   */
  it('refuses to collect anything when a backup does not say what it needs', async () => {
    const blob = await mirrorBlob('would be collected by a careless pass')
    await backupReferencing('2026-03-04T00-00-00.000Z', [])
    // A backup directory with no manifest at all, sitting beside it.
    await mkdir(join(backupRoot, '2026-03-05T00-00-00.000Z'), { recursive: true })

    const collected = await collectMirroredBlobs(backupRoot)

    expect(collected).toBe(0)
    expect(await mirroredDigests('blobs')).toEqual([blob])
  })

  /**
   * Retention counts BACKUPS, and so must this: an operator's own directory
   * sitting in the backup root is not a backup and must not be read as one
   * that references nothing.
   */
  it('ignores directories that are not backups', async () => {
    const kept = await mirrorBlob('referenced by the real backup')
    // An UNREFERENCED blob is what makes this test able to tell the two cases
    // apart. Counting `my-notes` as a backup would find it manifest-less and
    // stop the pass, so the harm runs the other way: collection would be
    // refused and this blob would survive. Asserting only that the referenced
    // one survives passes either way — measured, that version of this test
    // stayed green when the directory filter was broken.
    await mirrorBlob('referenced by nothing')
    await backupReferencing('2026-03-04T00-00-00.000Z', [kept])
    await mkdir(join(backupRoot, 'my-notes'), { recursive: true })

    expect(await collectMirroredBlobs(backupRoot)).toBe(1)
    expect(await mirroredDigests('blobs')).toEqual([kept])
  })

  it('has nothing to do when there is no mirror', async () => {
    expect(await collectMirroredBlobs(backupRoot)).toBe(0)
  })
})
