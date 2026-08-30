// The blob half of a backup, as a MIRROR rather than a copy (ADR-0021
// decision 5).
//
// Blobs are content-addressed and immutable, so the same bytes never need
// copying twice: a blob's path IS its identity, and a blob already in the
// mirror is already the right blob. What the previous shape did instead was
// copy the whole store on every pass, which costs one full copy per retained
// backup — measured at 403MB of backups over a 65MB store with the default
// retention of seven, and a pass that lengthened as the store grew because it
// re-copied everything every night.
//
// The mirror is APPEND-ONLY here. Nothing in this module deletes; that is
// retention's job through `collectableFromBackup`, and keeping the two apart
// is the whole point of decision 5 — file-GC must never delete from the
// backup, and the backup must never delete on GC's behalf.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getLogger } from '../log.js'

const log = getLogger('backup-blob-mirror')

// What `FsBlobStore` writes: `blobs/<first 2 hex>/<remaining 62 hex>`.
//
// `REST_OF_DIGEST` is the guard — it is what excludes a version thumbnail,
// whose name is `<versionId>.png`. `SHARD_NAME` is an optimisation on top: it
// stops the walk descending into a workspace's thumbnail tree at all, which
// on a large store is most of the directories under `blobs/`. Removing it
// changes no outcome, measured; do not mistake it for the thing keeping
// non-content-addressed files out.
const SHARD_NAME = /^[0-9a-f]{2}$/
const REST_OF_DIGEST = /^[0-9a-f]{62}$/

export const BLOB_MANIFEST_FILENAME = 'blobs.json'

/**
 * Which blobs one backup references.
 *
 * Recorded WITH the backup rather than derived later: retention needs to know
 * what this backup needs, and the store at retention time answers a different
 * question — what is live now. A blob no live document references any more is
 * still referenced by every retained backup taken while it was live.
 */
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  /** Full 64-hex digests, the same identity the store addresses by. */
  blobs: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
})

export interface MirrorBlobsOptions {
  /** Write the manifest into this backup directory. */
  manifestInto?: string
}

/**
 * Copy into `<backupRoot>/blobs` every content-addressed blob not already
 * there, and answer with everything this data directory references.
 *
 * The answer is every blob PRESENT, not every blob copied: a backup
 * references what it needs, and most of what it needs was mirrored on an
 * earlier night. Getting that wrong would let retention collect a blob that
 * an older backup still depends on.
 *
 * What is left alone: anything under `blobs/` that is not the sharded
 * content-addressed layout — today, version thumbnails at
 * `blobs/<workspaceId>/versions/<id>.png`. Those are addressed by NAME, so
 * the same path can hold different bytes over time and mirroring them by path
 * would silently make an old backup wrong. They travel in the ordinary
 * per-backup copy, as they always have. A workspace id is never two hex
 * characters, which is what makes the two layouts separable at all.
 */
export async function mirrorBlobsIntoBackup(
  dataDir: string,
  backupRoot: string,
  options: MirrorBlobsOptions = {},
): Promise<ReadonlySet<string>> {
  const sourceRoot = join(dataDir, 'blobs')
  const mirrorRoot = join(backupRoot, 'blobs')
  const referenced = new Set<string>()

  let shards: string[]
  try {
    shards = await readdir(sourceRoot)
  } catch {
    // No blobs directory at all is an ordinary state — a deployment that has
    // never had an upload.
    shards = []
  }

  for (const shard of shards) {
    if (!SHARD_NAME.test(shard)) continue
    let entries: string[]
    try {
      entries = await readdir(join(sourceRoot, shard))
    } catch (err) {
      log.warning({ shard, err }, 'could not list a blob shard; leaving it out of the mirror')
      continue
    }
    for (const rest of entries) {
      if (!REST_OF_DIGEST.test(rest)) continue
      referenced.add(`${shard}${rest}`)
      const destination = join(mirrorRoot, shard, rest)
      if (await exists(destination)) continue
      await mkdir(join(mirrorRoot, shard), { recursive: true })
      await copyAtomically(join(sourceRoot, shard, rest), destination)
    }
  }

  if (options.manifestInto) {
    await writeManifest(options.manifestInto, referenced)
  }
  return referenced
}

/**
 * The blobs a backup references, or `null` if it does not use the mirror.
 *
 * `null` is a distinct answer from an empty set, and the distinction is
 * load-bearing: a backup written before the mirror existed carries its blobs
 * inside itself, and reading it as "references nothing" would let retention
 * collect every blob a mirrored backup beside it still needs.
 *
 * Fails to `null` rather than throwing, for the same reason: an unreadable
 * manifest must not be read as an empty one.
 */
export async function readBackupBlobManifest(
  backupDir: string,
): Promise<ReadonlySet<string> | null> {
  let raw: string
  try {
    raw = await readFile(join(backupDir, BLOB_MANIFEST_FILENAME), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      log.warning({ backupDir }, 'blob manifest does not parse; treating the backup as unmirrored')
      return null
    }
    return new Set(parsed.data.blobs)
  } catch {
    log.warning({ backupDir }, 'blob manifest is not readable JSON; treating it as unmirrored')
    return null
  }
}

async function writeManifest(backupDir: string, blobs: ReadonlySet<string>): Promise<void> {
  const manifest = {
    schemaVersion: 1,
    // Sorted, so two backups of the same store produce the same bytes and a
    // diff between manifests reads as what changed rather than as reordering.
    blobs: [...blobs].sort(),
  } satisfies z.infer<typeof manifestSchema>
  await mkdir(backupDir, { recursive: true })
  await writeFile(join(backupDir, BLOB_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Copy through a temporary name in the destination shard, then rename.
 *
 * The mirror is append-only and read by restore, so a blob that appears must
 * be complete. A plain copy leaves it short for its duration, and a pass
 * killed in the middle would leave a truncated file at the address of real
 * content — which the next pass would then SKIP, because the address is
 * occupied. The rename is what makes appearing and being complete the same
 * event.
 */
async function copyAtomically(from: string, to: string): Promise<void> {
  const temp = `${to}.partial-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, await readFile(from))
    await rename(temp, to)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
