import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_DENY_FILE_READ } from '../../shared/test-utils/can-deny-file-read.js'
import { blobsRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import {
  type BackupBlobReferences,
  BackupManifestUnusableError,
  mirrorBlobsIntoBackup,
  readBackupBlobManifest,
} from './backup-blob-mirror.js'

let root: string
let dataDir: string
let backupRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-blob-mirror-'))
  dataDir = join(root, 'data')
  backupRoot = join(root, 'backups')
  await mkdir(dataDir, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The self-host tenant's half of a manifest — what a one-tenant keeper records. */
function selfBlobs(refs: BackupBlobReferences | null): ReadonlySet<string> {
  return refs?.tenants[SELF_HOST_TENANT_ID]?.blobs ?? new Set()
}
function selfFiles(refs: BackupBlobReferences | null): Readonly<Record<string, string>> {
  return refs?.tenants[SELF_HOST_TENANT_ID]?.files ?? {}
}

/** Write a blob where `FsBlobStore` would put it: `blobs/<2hex>/<62hex>`. */
async function putBlob(contents: string, tenantId: string = SELF_HOST_TENANT_ID): Promise<string> {
  const digest = createHash('sha256').update(contents).digest('hex')
  const dir = join(blobsRoot(dataDir, tenantId), digest.slice(0, 2))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, digest.slice(2)), contents)
  return digest
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size
  }
  return total
}

/**
 * ADR-0021 decision 5: a blob's durable copy is a MIRROR, not a per-backup
 * snapshot. Blobs are content-addressed and immutable, so the same bytes
 * never need copying twice — and a backup that copies the whole store every
 * night costs the operator one full copy per retained backup.
 *
 * Measured on the shape this replaces: a 51MB store growing 5% a day, with
 * `WHITEBOARD_BACKUP_KEEP=7`, occupied 403MB of backups by day six — 6.18x
 * the data it protects — and each pass copied the entire store, so the pass
 * itself lengthened from 368ms to 486ms as the store grew.
 */
describe('the backup blob mirror', () => {
  it('copies a blob once, however many backups reference it', async () => {
    const first = await putBlob('a'.repeat(10_000))
    const second = await putBlob('b'.repeat(10_000))

    const one = await mirrorBlobsIntoBackup(dataDir, backupRoot)
    const two = await mirrorBlobsIntoBackup(dataDir, backupRoot)

    expect([...selfBlobs(one)].sort()).toEqual([first, second].sort())
    // The second pass reports the same references — a backup references
    // every blob it needs, not only the ones it happened to copy.
    expect([...selfBlobs(two)].sort()).toEqual([first, second].sort())

    // …and the store holds one copy, not two.
    const mirrored = await dirBytes(join(backupRoot, 'blobs'))
    expect(mirrored).toBeGreaterThan(19_000)
    expect(mirrored).toBeLessThan(21_000)
  })

  /**
   * The other half of the cost, and NOT the one above.
   *
   * Deduplication is inherent to content addressing: re-copying a blob
   * overwrites its own address, so the mirror does not grow either way and
   * the size ratio below stays healthy even with the skip removed — measured,
   * that mutation left every size assertion green. What re-copying costs is
   * the PASS: reading and writing the whole store every night, which is what
   * made the old shape slower as the data grew. Only an untouched file proves
   * the skip happened.
   */
  it('reads a manifest written before tenants existed as the tenant that keeper had', async () => {
    // v2 recorded one keeper's blobs with no tenant. Read as "no tenant at
    // all" a restore would put nothing back; read as the self-host tenant it
    // puts them where that keeper kept them.
    const backupDir = join(backupRoot, '2026-01-01T00-00-00.000Z')
    await mkdir(backupDir, { recursive: true })
    const digest = 'a'.repeat(64)
    await writeFile(
      join(backupDir, 'blobs.json'),
      JSON.stringify({
        schemaVersion: 2,
        blobs: [digest],
        files: { '01JWORKSPACE00000000000000/versions/v1.png': 'b'.repeat(64) },
        mirror: 'parent',
      }),
    )
    const refs = await readBackupBlobManifest(backupDir)
    expect(refs?.mirror).toBe('parent')
    expect(Object.keys(refs?.tenants ?? {})).toEqual([SELF_HOST_TENANT_ID])
    expect(refs?.tenants[SELF_HOST_TENANT_ID]?.blobs).toEqual(new Set([digest]))
    expect(refs?.tenants[SELF_HOST_TENANT_ID]?.files).toEqual({
      '01JWORKSPACE00000000000000/versions/v1.png': 'b'.repeat(64),
    })
  })

  it('mirrors every tenant, and records which tenant each blob belongs to', async () => {
    // A keeper holds tenants; a backup is the keeper's. Mirroring one tenant
    // leaves the others with no durable copy at all, and a manifest that does
    // not say whose a blob is cannot restore it to the right place.
    const mine = await putBlob('tenant one bytes')
    const theirs = await putBlob('tenant two bytes', 'tenant-two')
    const backupDir = join(backupRoot, '2026-03-04T05-06-07.000Z')
    const refs = await mirrorBlobsIntoBackup(dataDir, backupRoot, {
      manifestInto: backupDir,
      mirror: 'parent',
    })

    expect(refs.tenants[SELF_HOST_TENANT_ID]?.blobs).toEqual(new Set([mine]))
    expect(refs.tenants['tenant-two']?.blobs).toEqual(new Set([theirs]))
    // The mirror itself stays flat: a blob's path there IS its digest.
    for (const digest of [mine, theirs]) {
      expect(
        await readFile(join(backupRoot, 'blobs', digest.slice(0, 2), digest.slice(2)), 'utf8'),
      ).toBeTruthy()
    }
    const reread = await readBackupBlobManifest(backupDir)
    expect(reread?.tenants['tenant-two']?.blobs).toEqual(new Set([theirs]))
  })

  it('does not re-copy a blob it has already mirrored', async () => {
    const digest = await putBlob('mirrored once')
    await mirrorBlobsIntoBackup(dataDir, backupRoot)
    const mirroredPath = join(backupRoot, 'blobs', digest.slice(0, 2), digest.slice(2))
    const first = await stat(mirroredPath)

    // Far enough apart that a rewrite cannot land in the same mtime tick.
    await new Promise((r) => setTimeout(r, 20))
    await mirrorBlobsIntoBackup(dataDir, backupRoot)

    expect((await stat(mirroredPath)).mtimeMs).toBe(first.mtimeMs)
  })

  /**
   * The instrument, kept as an assertion rather than a note: three passes
   * over a store that grows a little each time must not cost three copies of
   * it. A RATIO rather than a byte count, so it means the same on any
   * machine.
   */
  it('keeps the mirror the size of the data, not a multiple of it', async () => {
    for (let day = 0; day < 3; day++) {
      for (let i = 0; i < 10; i++) await putBlob(`day-${day}-blob-${i}-${'x'.repeat(5_000)}`)
      await mirrorBlobsIntoBackup(dataDir, backupRoot)
    }

    const store = await dirBytes(blobsRoot(dataDir, SELF_HOST_TENANT_ID))
    const mirrored = await dirBytes(join(backupRoot, 'blobs'))
    expect(mirrored / store).toBeLessThan(1.1)
  })

  /**
   * Version thumbnails live under `blobs/<workspaceId>/versions/` and are NOT
   * content-addressed, so the same path can hold different bytes over time.
   * Mirroring them by path would make the backup silently wrong, so they are
   * left to the ordinary per-backup copy.
   *
   * What excludes them is the FILE name: `<versionId>.png` is not 62 hex
   * characters. The shard-name check upstream is a walk-skipping optimisation
   * — measured, removing it leaves this test green — so do not read it as the
   * guard, and do not delete this test on the strength of it.
   */
  it('leaves what is not content-addressed alone', async () => {
    await putBlob('real blob')
    const thumbs = join(
      blobsRoot(dataDir, SELF_HOST_TENANT_ID),
      '01JTESTWORKSPACE0000000000',
      'versions',
    )
    await mkdir(thumbs, { recursive: true })
    await writeFile(join(thumbs, 'v1.png'), 'not a blob')

    await mirrorBlobsIntoBackup(dataDir, backupRoot)

    const shards = await readdir(join(backupRoot, 'blobs'))
    expect(shards).toEqual([createHash('sha256').update('real blob').digest('hex').slice(0, 2)])
  })

  it('is content, not just a name: a mirrored blob reads back byte for byte', async () => {
    const digest = await putBlob('the actual bytes')
    await mirrorBlobsIntoBackup(dataDir, backupRoot)
    const copied = await readFile(
      join(backupRoot, 'blobs', digest.slice(0, 2), digest.slice(2)),
      'utf8',
    )
    expect(copied).toBe('the actual bytes')
  })

  it('has nothing to say about a data directory with no blobs', async () => {
    const empty = await mirrorBlobsIntoBackup(dataDir, backupRoot)
    expect(empty.tenants).toEqual({})
    // A keeper with no tenant directory has nothing to mirror and says so.
  })

  /**
   * Version thumbnails are addressed by NAME, so the mirror cannot key them
   * on their path the way it keys a blob — the same path can hold different
   * bytes over time, and a later pass would silently overwrite what an older
   * backup still depends on. They are keyed on their CONTENT instead, in a
   * store of their own, and the manifest records which digest each path had
   * at that pass.
   *
   * Two stores rather than one because the two halves know different things.
   * A sharded blob's path already IS its content address, so presence at that
   * path settles identity without reading the file — which is what keeps a
   * nightly pass from re-reading the whole store. A named file has to be
   * hashed to answer the same question, and hashing thumbnails is cheap
   * against copying them all every night, which is what happens today.
   */
  describe('files addressed by name', () => {
    async function putThumbnail(workspaceId: string, version: string, contents: string) {
      const dir = join(blobsRoot(dataDir, SELF_HOST_TENANT_ID), workspaceId, 'versions')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${version}.png`), contents)
      return createHash('sha256').update(contents).digest('hex')
    }

    it('mirrors a named file under its content digest', async () => {
      const digest = await putThumbnail('01JWORKSPACE00000000000000', 'v1', 'thumb bytes')
      const backupDir = join(backupRoot, '2026-03-04T05-06-07.000Z')
      await mirrorBlobsIntoBackup(dataDir, backupRoot, {
        manifestInto: backupDir,
        mirror: 'parent',
      })

      const stored = await readFile(
        join(backupRoot, 'files', digest.slice(0, 2), digest.slice(2)),
        'utf8',
      )
      expect(stored).toBe('thumb bytes')

      const manifest = await readBackupBlobManifest(backupDir)
      expect(selfFiles(manifest)).toEqual({
        '01JWORKSPACE00000000000000/versions/v1.png': digest,
      })
    })

    /**
     * The case path-keying gets wrong. Two backups, the same path, different
     * bytes: both must still be restorable, which means the mirror has to be
     * holding both.
     */
    it('keeps both versions when the same path is rewritten', async () => {
      const dayOne = join(backupRoot, '2026-03-04T00-00-00.000Z')
      const first = await putThumbnail('01JWORKSPACE00000000000000', 'v1', 'the first bytes')
      await mirrorBlobsIntoBackup(dataDir, backupRoot, { manifestInto: dayOne, mirror: 'parent' })

      const dayTwo = join(backupRoot, '2026-03-05T00-00-00.000Z')
      const second = await putThumbnail('01JWORKSPACE00000000000000', 'v1', 'rewritten bytes')
      await mirrorBlobsIntoBackup(dataDir, backupRoot, { manifestInto: dayTwo, mirror: 'parent' })

      expect(first).not.toBe(second)
      const path = '01JWORKSPACE00000000000000/versions/v1.png'
      expect(selfFiles(await readBackupBlobManifest(dayOne))[path]).toBe(first)
      expect(selfFiles(await readBackupBlobManifest(dayTwo))[path]).toBe(second)
      for (const digest of [first, second]) {
        expect(
          await readFile(join(backupRoot, 'files', digest.slice(0, 2), digest.slice(2)), 'utf8'),
        ).toBeTruthy()
      }
    })

    it('does not re-copy a named file whose content has not changed', async () => {
      const digest = await putThumbnail('01JWORKSPACE00000000000000', 'v1', 'stable bytes')
      await mirrorBlobsIntoBackup(dataDir, backupRoot)
      const stored = join(backupRoot, 'files', digest.slice(0, 2), digest.slice(2))
      const before = await stat(stored)

      await new Promise((r) => setTimeout(r, 20))
      await mirrorBlobsIntoBackup(dataDir, backupRoot)

      expect((await stat(stored)).mtimeMs).toBe(before.mtimeMs)
    })
  })

  describe('the manifest', () => {
    /**
     * Which blobs a backup references has to be recorded WITH the backup: it
     * is what retention reads to decide whether a blob is still needed, and
     * what restore reads to know what to materialise. Reading it off the
     * store at retention time would answer a different question — what is
     * live now, not what this backup needs.
     */
    it('round-trips the references it was written with', async () => {
      const digest = await putBlob('referenced')
      const backupDir = join(backupRoot, '2026-03-04T05-06-07.000Z')
      await mkdir(backupDir, { recursive: true })
      const refs = await mirrorBlobsIntoBackup(dataDir, backupRoot, {
        manifestInto: backupDir,
        mirror: 'parent',
      })

      expect(selfBlobs(await readBackupBlobManifest(backupDir))).toEqual(selfBlobs(refs))
      expect([...selfBlobs(refs)]).toEqual([digest])
    })

    /**
     * A backup written before this existed has no manifest, and must not be
     * mistaken for one that references nothing — that reading would let
     * retention collect every blob it needs. `null` says "this backup does
     * not use the mirror", which is a different answer from an empty set.
     */
    it('answers null for a backup that predates it', async () => {
      const old = join(backupRoot, '2026-01-01T00-00-00.000Z')
      await mkdir(old, { recursive: true })
      expect(await readBackupBlobManifest(old)).toBeNull()
    })

    /**
     * `null` is the answer for a backup that has NO manifest, and a damaged
     * one is not that: the file is there, so the backup did use the mirror,
     * and nothing about it may be read as "carries its blobs inside itself".
     */
    it.skipIf(!CAN_DENY_FILE_READ)(
      'throws on a manifest this process is not allowed to read',
      async () => {
        const locked = join(backupRoot, '2026-01-03T00-00-00.000Z')
        await mkdir(locked, { recursive: true })
        await writeFile(join(locked, 'blobs.json'), '{}')
        await chmod(join(locked, 'blobs.json'), 0o000)
        try {
          await expect(readBackupBlobManifest(locked)).rejects.toBeInstanceOf(
            BackupManifestUnusableError,
          )
        } finally {
          await chmod(join(locked, 'blobs.json'), 0o600)
        }
      },
    )

    it('throws on a manifest that is there but cannot be read', async () => {
      const broken = join(backupRoot, '2026-01-02T00-00-00.000Z')
      await mkdir(broken, { recursive: true })
      await writeFile(join(broken, 'blobs.json'), '{ not json')
      await expect(readBackupBlobManifest(broken)).rejects.toBeInstanceOf(
        BackupManifestUnusableError,
      )
    })
  })
})
