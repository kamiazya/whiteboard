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

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
import { blobRefSchema } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { isMissingFileError } from '../../shared/errno.js'
import { isSafePathSegment, isSafeRelativePosixPath } from '../../shared/path-containment.js'
import { sha256Hex } from '../../shared/sha256.js'
import { writeFileAtomic } from '../../shared/write-file-atomic.js'
import { getLogger } from '../log.js'
import {
  BLOBS_DIRNAME,
  blobShardDir,
  blobShardPath,
  blobsRoot,
  FILES_DIRNAME,
  isBlobShardName,
  listTenants,
  parseBlobShard,
} from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

const log = getLogger('backup-blob-mirror')

// What `FsBlobStore` writes is `data-layout`'s `blobShardPath`, and the mirror
// uses the same one, so a blob's mirror path follows from its digest.
//
// `parseBlobShard` is the guard that keeps anything not named like a digest
// out of the sharded half; `isBlobShardName` is an optimisation on top that
// stops the walk descending into a non-sharded tree at all. Removing the
// latter changes no outcome, measured; do not mistake it for the thing keeping
// non-content-addressed files out.
//
// Nothing WRITES a non-sharded tree under `blobs/`: version
// thumbnails were the only one, and they are retired. The two halves stay
// because backups already on disk still carry those pictures in their
// `files` map, and a reader that no longer knows the shape would make a
// retained backup partly unrestorable.

const BLOB_MANIFEST_FILENAME = 'blobs.json'

// The digest's shape is the `BlobRef` contract's, not restated here.
const DIGEST = blobRefSchema.shape.digestHex

// A manifest is an artifact a restore reads from somewhere it does not
// control, and these two strings are joined under the target data directory
// there. Refused at the schema so no reader of the manifest has to remember to
// check, and so the writer, which holds itself to the same two schemas, cannot
// record what its own reader would refuse.
const TENANT_ID = z.string().refine(isSafePathSegment, 'a tenant id is one path segment')
const FILE_PATH = z
  .string()
  .refine(isSafeRelativePosixPath, 'a file path is relative, with no `.`, `..` or empty segment')

/**
 * Which blobs one backup references.
 *
 * Recorded WITH the backup rather than derived later: retention needs to know
 * what this backup needs, and the store at retention time answers a different
 * question — what is live now. A blob no live document references any more is
 * still referenced by every retained backup taken while it was live.
 */
const tenantReferencesSchema = z.object({
  /**
   * The sharded content-addressed store, by digest — the same identity
   * `FsBlobStore` addresses by, so the mirror path follows from the digest
   * and nothing needs recording twice.
   */
  blobs: z.array(DIGEST),
  /**
   * Everything else under `blobs/`, as `<relative path>` to the digest of
   * what that path held AT THIS PASS. A named file is addressed by its path
   * rather than its content, so the path alone does not say which bytes a
   * backup needs — two backups can legitimately want different content at
   * the same path. Written by nothing today; read for backups that predate
   * the version thumbnail's retirement.
   */
  files: z.record(FILE_PATH, DIGEST),
})

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
const mirrorLocationSchema = z.enum(['self', 'parent'])

/**
 * v3 records WHOSE each blob is. A keeper holds tenants, and the mirror is
 * flat because a blob's path there is its digest — so without the tenant a
 * restore knows the bytes and not where they go, and would put every tenant's
 * blobs in one.
 */
const manifestSchema = z.object({
  schemaVersion: z.literal(3),
  tenants: z.record(TENANT_ID, tenantReferencesSchema),
  mirror: mirrorLocationSchema,
})

/** What a backup taken before tenants existed recorded: one keeper, one set. */
const legacyManifestSchema = z.object({
  schemaVersion: z.literal(2),
  blobs: z.array(DIGEST),
  files: z.record(FILE_PATH, DIGEST),
  mirror: mirrorLocationSchema,
})

/** What one backup references, in the two shapes the mirror stores. */
interface TenantBlobReferences {
  blobs: ReadonlySet<string>
  files: Readonly<Record<string, string>>
}

export interface BackupBlobReferences {
  /** By tenant id. A backup taken before tenants existed reads as the self-host one. */
  tenants: Readonly<Record<string, TenantBlobReferences>>
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
 * content-addressed layout by path, and everything else by the digest of its
 * own bytes. A workspace id is never two hex characters, which is what makes
 * the two layouts separable at all. Only the sharded half has a producer
 * now; see the note at the top of this file for why the other is kept.
 */
export async function mirrorBlobsIntoBackup(
  dataDir: string,
  backupRoot: string,
  options: MirrorBlobsOptions = {},
): Promise<BackupBlobReferences> {
  // Every tenant the keeper holds: a backup is the KEEPER's, and mirroring one
  // tenant would leave the others with no durable copy at all. The mirror
  // itself stays flat, because a blob's path there IS its digest — two tenants
  // holding the same bytes share the one copy, and the manifest says whose.
  const tenants: Record<string, TenantBlobReferences> = {}
  for (const tenantId of await listTenants(dataDir)) {
    tenants[tenantId] = await mirrorOneTenant(blobsRoot(dataDir, tenantId), backupRoot)
  }

  const references: BackupBlobReferences = { tenants, mirror: options.mirror ?? 'self' }
  if (options.manifestInto) {
    await writeManifest(options.manifestInto, references)
  }
  return references
}

async function mirrorOneTenant(
  sourceRoot: string,
  backupRoot: string,
): Promise<TenantBlobReferences> {
  const blobs = new Set<string>()
  const files: Record<string, string> = {}
  // No blobs directory at all is an ordinary state — a tenant that has never
  // had an upload.
  const shards = await readdir(sourceRoot).catch(() => [] as string[])
  for (const entry of shards) {
    if (isBlobShardName(entry)) {
      await mirrorShard(sourceRoot, backupRoot, entry, blobs)
    } else {
      await mirrorNamedTree(sourceRoot, backupRoot, entry, files)
    }
  }
  return { blobs, files }
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
    const digest = parseBlobShard(shard, rest)
    if (digest === null) continue
    into.add(digest)
    const destination = blobShardPath(join(backupRoot, BLOBS_DIRNAME), digest)
    if (await exists(destination)) continue
    await mkdir(blobShardDir(join(backupRoot, BLOBS_DIRNAME), digest), { recursive: true })
    await copyAtomically(blobShardPath(sourceRoot, digest), destination)
  }
}

/**
 * Everything under `blobs/` that is not the sharded store. Nothing writes
 * such a tree today; this reads the ones retained backups already hold.
 *
 * Keyed on CONTENT, not on path. Keying on path is what the old whole-tree
 * copy effectively did, and it is wrong here for a reason a size measurement
 * never shows: a named file's path can be written again with different
 * bytes. Mirroring by path would let a later pass overwrite bytes an older
 * retained backup still depends on — a backup that was restorable yesterday
 * and is not today, with no error anywhere.
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
    const digest = sha256Hex(bytes)
    into[file.relative] = digest
    const destination = blobShardPath(join(backupRoot, FILES_DIRNAME), digest)
    if (await exists(destination)) continue
    await mkdir(blobShardDir(join(backupRoot, FILES_DIRNAME), digest), { recursive: true })
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
 * `null` means the backup has NO manifest, and only that. A manifest that is
 * there but cannot be read or parsed throws `BackupManifestUnusableError`:
 * the file's presence says the backup DID use the mirror, so reading it as
 * "pre-mirror" is as wrong as reading it as empty. Restore read it that way
 * once, copied the mirror's own stores into the data directory as if they
 * were the backup's blobs, and reported success over documents pointing at
 * nothing. Each caller decides what an unusable manifest costs it —
 * retention collects nothing, restore refuses.
 */
export async function readBackupBlobManifest(
  backupDir: string,
): Promise<BackupBlobReferences | null> {
  let raw: string
  try {
    raw = await readFile(join(backupDir, BLOB_MANIFEST_FILENAME), 'utf8')
  } catch (err) {
    if (isMissingFileError(err)) return null
    throw new BackupManifestUnusableError(backupDir, 'cannot be read', err)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new BackupManifestUnusableError(backupDir, 'is not JSON', err)
  }
  const parsed = manifestSchema.safeParse(json)
  if (parsed.success) {
    return {
      tenants: Object.fromEntries(
        Object.entries(parsed.data.tenants).map(([tenantId, refs]) => [
          tenantId,
          { blobs: new Set(refs.blobs), files: refs.files },
        ]),
      ),
      mirror: parsed.data.mirror,
    }
  }
  // A backup taken before tenants existed: one keeper, one set, and the
  // tenant it belongs to is the one that keeper had.
  const legacy = legacyManifestSchema.safeParse(json)
  if (legacy.success) {
    return {
      tenants: {
        [SELF_HOST_TENANT_ID]: { blobs: new Set(legacy.data.blobs), files: legacy.data.files },
      },
      mirror: legacy.data.mirror,
    }
  }
  throw new BackupManifestUnusableError(backupDir, 'does not match any manifest version', undefined)
}

/** A backup's blob manifest is present but cannot be used; see `readBackupBlobManifest`. */
export class BackupManifestUnusableError extends Error {
  constructor(
    readonly backupDir: string,
    why: string,
    cause: unknown,
  ) {
    super(`the blob manifest of backup ${backupDir} ${why}`, { cause })
    this.name = 'BackupManifestUnusableError'
  }
}

/**
 * The manifest a restore will accept, from what a pass found.
 *
 * The reader refuses a tenant id or a file path it could not join safely, and
 * refuses the WHOLE manifest for one such entry. The writer holds itself to the
 * same key schemas (`TENANT_ID`, `FILE_PATH`), because a pass that records an entry its own restore refuses
 * succeeds into a backup that cannot be restored, and retention then reads the
 * manifest as unusable and collects nothing. Such an entry is left out and
 * named instead: it could not have been written back anyway.
 */
function recordableManifest(references: BackupBlobReferences) {
  const tenants: Record<string, { blobs: string[]; files: Record<string, string> }> = {}
  // Sorted, so two backups of the same store produce the same bytes and a diff
  // between manifests reads as what changed rather than as reordering.
  for (const [tenantId, refs] of Object.entries(references.tenants).sort(byKey)) {
    if (!TENANT_ID.safeParse(tenantId).success) {
      log.warning({ tenantId }, 'left a tenant out of the backup manifest; its id is not a name')
      continue
    }
    const files: Record<string, string> = {}
    for (const [path, digest] of Object.entries(refs.files).sort(byKey)) {
      if (!FILE_PATH.safeParse(path).success) {
        log.warning(
          { tenantId, path },
          'left a file out of the backup manifest; a restore would refuse its path',
        )
        continue
      }
      files[path] = digest
    }
    tenants[tenantId] = { blobs: [...refs.blobs].sort(), files }
  }
  return { schemaVersion: 3, tenants, mirror: references.mirror } satisfies z.infer<
    typeof manifestSchema
  >
}

function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  return a < b ? -1 : 1
}

async function writeManifest(backupDir: string, references: BackupBlobReferences): Promise<void> {
  const manifest = recordableManifest(references)
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
  await writeFileAtomic(to, await readFile(from))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
