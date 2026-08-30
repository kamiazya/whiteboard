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

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
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
const DIGEST = /^[0-9a-f]{64}$/

const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  /**
   * The sharded content-addressed store, by digest — the same identity
   * `FsBlobStore` addresses by, so the mirror path follows from the digest
   * and nothing needs recording twice.
   */
  blobs: z.array(z.string().regex(DIGEST)),
  /**
   * Everything else under `blobs/`, as `<relative path>` to the digest of
   * what that path held AT THIS PASS. Version thumbnails are addressed by
   * name, so the path alone does not say which bytes a backup needs — two
   * backups can legitimately want different content at the same path.
   */
  files: z.record(z.string(), z.string().regex(DIGEST)),
  /**
   * Where the mirror this backup reads from lives, said rather than inferred.
   *
   * `self` is a one-off `whiteboard server backup --output-dir=X`: the mirror
   * is inside X, so the directory can be carried somewhere and restored on
   * its own, which is the affordance the shared shape would otherwise take
   * away. `parent` is the schedule, where every retained backup shares one
   * mirror beside them.
   *
   * Recorded because restore would otherwise have to guess by looking for a
   * `blobs/` directory in two places, and a guess that picks the wrong one
   * restores the wrong bytes without saying so.
   */
  mirror: z.enum(['self', 'parent']),
})

/** What one backup references, in the two shapes the mirror stores. */
export interface BackupBlobReferences {
  blobs: ReadonlySet<string>
  files: Readonly<Record<string, string>>
  mirror: 'self' | 'parent'
}

/** Where a backup's mirror is, from what its manifest recorded. */
export function mirrorRootFor(backupDir: string, references: BackupBlobReferences): string {
  return references.mirror === 'self' ? backupDir : dirname(backupDir)
}

export interface MirrorBlobsOptions {
  /** Write the manifest into this backup directory. */
  manifestInto?: string
  /** What the manifest should record about where the mirror lives. */
  mirror?: 'self' | 'parent'
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
 * Everything under `blobs/` is mirrored, in one of two stores: the sharded
 * content-addressed layout by path, and everything else — today, version
 * thumbnails at `blobs/<workspaceId>/versions/<id>.png` — by the digest of
 * its own bytes. A workspace id is never two hex characters, which is what
 * makes the two layouts separable at all.
 */
export async function mirrorBlobsIntoBackup(
  dataDir: string,
  backupRoot: string,
  options: MirrorBlobsOptions = {},
): Promise<BackupBlobReferences> {
  const sourceRoot = join(dataDir, 'blobs')
  const blobs = new Set<string>()
  const files: Record<string, string> = {}

  let shards: string[]
  try {
    shards = await readdir(sourceRoot)
  } catch {
    // No blobs directory at all is an ordinary state — a deployment that has
    // never had an upload.
    shards = []
  }

  for (const entry of shards) {
    if (SHARD_NAME.test(entry)) {
      await mirrorShard(sourceRoot, backupRoot, entry, blobs)
    } else {
      await mirrorNamedTree(sourceRoot, backupRoot, entry, files)
    }
  }

  const references: BackupBlobReferences = { blobs, files, mirror: options.mirror ?? 'self' }
  if (options.manifestInto) {
    await writeManifest(options.manifestInto, references)
  }
  return references
}

/**
 * One shard of the content-addressed store.
 *
 * No file is read: the path already is the content address, so a blob already
 * at that path in the mirror is already the right blob. That is what keeps a
 * nightly pass from re-reading a store that has not changed.
 */
async function mirrorShard(
  sourceRoot: string,
  backupRoot: string,
  shard: string,
  into: Set<string>,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(join(sourceRoot, shard))
  } catch (err) {
    log.warning({ shard, err }, 'could not list a blob shard; leaving it out of the mirror')
    return
  }
  for (const rest of entries) {
    if (!REST_OF_DIGEST.test(rest)) continue
    into.add(`${shard}${rest}`)
    const destination = join(backupRoot, 'blobs', shard, rest)
    if (await exists(destination)) continue
    await mkdir(join(backupRoot, 'blobs', shard), { recursive: true })
    await copyAtomically(join(sourceRoot, shard, rest), destination)
  }
}

/**
 * Everything under `blobs/` that is not the sharded store — today, a
 * workspace's version thumbnails.
 *
 * Keyed on CONTENT, not on path. Keying on path is what the old whole-tree
 * copy effectively did, and it is wrong here for a reason a size measurement
 * never shows: `saveThumbnail` writes to `<workspaceId>/versions/<id>.png`,
 * and nothing stops the same path being written again. Mirroring by path
 * would let a later pass overwrite bytes an older retained backup still
 * depends on — a backup that was restorable yesterday and is not today, with
 * no error anywhere.
 *
 * Reading each file to hash it is the cost of that safety. It is paid against
 * the alternative of COPYING each file every night, which is what happens
 * without this.
 */
async function mirrorNamedTree(
  sourceRoot: string,
  backupRoot: string,
  entry: string,
  into: Record<string, string>,
): Promise<void> {
  let found: Array<{ absolute: string; relative: string }>
  try {
    found = await walkFiles(join(sourceRoot, entry), sourceRoot)
  } catch (err) {
    log.warning({ entry, err }, 'could not walk a named blob tree; leaving it out of the mirror')
    return
  }
  for (const file of found) {
    let bytes: Buffer
    try {
      bytes = await readFile(file.absolute)
    } catch (err) {
      log.warning({ path: file.relative, err }, 'could not read a file for the mirror')
      continue
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    into[file.relative] = digest
    const destination = join(backupRoot, 'files', digest.slice(0, 2), digest.slice(2))
    if (await exists(destination)) continue
    await mkdir(join(backupRoot, 'files', digest.slice(0, 2)), { recursive: true })
    await copyAtomically(file.absolute, destination)
  }
}

async function walkFiles(
  dir: string,
  root: string,
): Promise<Array<{ absolute: string; relative: string }>> {
  const found: Array<{ absolute: string; relative: string }> = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const absolute = join(entry.parentPath, entry.name)
    // POSIX separators in the manifest, so a backup taken on one platform
    // restores on another. The manifest is an artifact an operator can carry.
    found.push({ absolute, relative: relative(root, absolute).split(sep).join(posix.sep) })
  }
  return found
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
): Promise<BackupBlobReferences | null> {
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
    return {
      blobs: new Set(parsed.data.blobs),
      files: parsed.data.files,
      mirror: parsed.data.mirror,
    }
  } catch {
    log.warning({ backupDir }, 'blob manifest is not readable JSON; treating it as unmirrored')
    return null
  }
}

async function writeManifest(backupDir: string, references: BackupBlobReferences): Promise<void> {
  const manifest = {
    schemaVersion: 2,
    // Sorted, so two backups of the same store produce the same bytes and a
    // diff between manifests reads as what changed rather than as reordering.
    blobs: [...references.blobs].sort(),
    files: Object.fromEntries(
      Object.entries(references.files).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    mirror: references.mirror,
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
