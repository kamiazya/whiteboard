import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { DAEMON_RECORD_FILENAME } from '../daemon/daemon-registry.js'
import { PENDING_WRITES_DIRNAME } from './atomic-write.js'
import type { BackupBlobReferences } from './store/backup-blob-mirror.js'
import { mirrorRootFor, readBackupBlobManifest } from './store/backup-blob-mirror.js'
import { BACKUP_MARKER_FILENAME } from './store/backup-in-progress.js'
import { DB_FILENAME } from './store/db/location.js'

// Backup / restore drill helper for the local daemon data directory.
//
// Layout the data dir is expected to carry (see store/db, document-store,
// version-store, routes/files):
//   <data>/whiteboard.db                                   libsql DB
//                                                          (workspaces, documents, versions
//                                                           metadata + frontiers, branches,
//                                                           runtime)
//   <data>/<workspaceId>/files/<fileId>.<ext>              binary file blobs (image attachments)
//   <data>/blobs/<workspaceId>/document/<documentId>.loro      Loro canvas snapshot
//   <data>/blobs/<workspaceId>/versions/<versionId>.png    optional version thumbnail
// Per-version `.loro` files are NOT written — version state is captured by
// frontiers in the DB plus the live canvas snapshot.
//
// MVP contract: copy the data dir wholesale, restore into a fresh dir,
// verify the daemon can read it again. No archive format, no encryption,
// no cloud retention, no public CLI command — those are non-goals here.
// The tree must contain no symlinks: a hostile backup or seeded src
// could otherwise point inside the data dir at arbitrary filesystem
// state, and a later daemon read would silently follow it.

export class BackupError extends Error {
  override readonly name = 'BackupError'
}

export interface BackupRestoreOptions {
  // The full set of absolute path prefixes the helper is allowed to
  // read from / write to. Every src + dest in a backup or restore
  // must canonicalize inside one of them. Tests pass their temp dir.
  // The runtime caller (e.g. a future support-bundle CLI) would pass
  // the user data dir + a sibling backup dir.
  allowedRoots: string[]
  // Leave `whiteboard.db` out of the copy. Set when the deployment keeps its
  // rows elsewhere, where any file of that name in the directory is a fossil
  // from before the move — it looks exactly like a live database, and a
  // restore would put its pre-migration rows back as though they were
  // current. Backup only.
  excludeDatabaseFile?: boolean
  /**
   * Leave `blobs/` out of the tree copy, because the mirror carries it
   * (ADR-0021 decision 5). Set by `performBackup`; restore puts the tree back
   * and then materialises the blobs from the manifest.
   */
  excludeBlobs?: boolean
}

// Canonicalize `p` by resolving symlinks on the deepest existing ancestor.
// `resolve()` does NOT follow symlinks, so an ancestor symlink (e.g.
// `<allowed>/link → /outside`) passes a plain resolve()-based prefix check
// while actually pointing outside the allowed tree. `realpath` on the deepest
// existing ancestor fixes that.
//
// Exported so CLI callers can canonicalize user-supplied paths before
// passing them to helpers, ensuring the `allowedRoots` guard sees real paths.
async function canonicalizePath(p: string): Promise<string> {
  const abs = resolve(p)
  const parts = abs.split(sep)
  let existingLen = parts.length
  while (existingLen > 1) {
    const candidate = parts.slice(0, existingLen).join(sep) || sep
    try {
      await lstat(candidate)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      existingLen--
    }
  }
  const existingPart = parts.slice(0, existingLen).join(sep) || sep
  const real = await realpath(existingPart)
  const tail = parts.slice(existingLen)
  return tail.length === 0 ? real : join(real, ...tail)
}

// Walk every existing path component of `p` from the deepest toward the root.
// Returns true if any component is a symbolic link.
// Used by CLI callers to fail-closed before passing paths to the helper, so
// an ancestor symlink (e.g. `<safe>/link → /outside`) cannot redirect writes
// to locations outside the operator's intended storage zone.
export async function hasAncestorSymlink(p: string): Promise<boolean> {
  let current = resolve(p)
  while (true) {
    const parent = dirname(current)
    if (parent === current) break // reached filesystem root
    try {
      const st = await lstat(current)
      if (st.isSymbolicLink()) return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // Component does not exist yet; check its parent.
    }
    current = parent
  }
  return false
}

async function assertWithinAllowed(
  target: string,
  options: BackupRestoreOptions,
  label: string,
): Promise<void> {
  const canonical = await canonicalizePath(target)
  for (const root of options.allowedRoots) {
    const canonicalRoot = await canonicalizePath(root)
    if (canonical === canonicalRoot || canonical.startsWith(canonicalRoot + sep)) return
  }
  // The error MUST NOT echo the resolved target — that would leak the
  // full local path back to a user-facing surface in a future support
  // bundle / log capture.
  throw new BackupError(`${label} is not inside an allowed root.`)
}

async function isEmptyDirOrMissing(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.length === 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw err
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await lstat(dir)
    return s.isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

// Walk `root` recursively via lstat (NOT stat — lstat does not follow
// symlinks) and reject if any entry is a symlink or a non-regular
// non-directory entry. The data-dir contract is "regular files and
// directories only"; tolerating anything else makes a future support
// bundle / restore drill quietly accept a tree that the daemon would
// then dereference at read time.
async function assertNoSymlinks(root: string, label: string): Promise<void> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const childPath = join(dir, entry.name)
      const s = await lstat(childPath)
      if (s.isSymbolicLink()) {
        throw new BackupError(`${label} contains a symlink, which is not allowed.`)
      }
      if (s.isDirectory()) {
        stack.push(childPath)
        continue
      }
      if (!s.isFile()) {
        throw new BackupError(
          `${label} contains a non-regular entry (e.g. socket / device / fifo), which is not allowed.`,
        )
      }
    }
  }
}

/**
 * Entries that never travel into a backup, whatever else is happening.
 *
 * - The staging area holds mid-flight bytes under names no digest or file id
 *   matches, so a copy of one resolves to nothing. It is also the entry a
 *   live copy is most likely to trip over: `cp` stats each name it listed,
 *   and a file renamed away in between raises ENOENT for the whole backup.
 * - The daemon record holds the Bearer token the daemon authenticates HTTP
 *   and WS with, which is why it is written owner-only. A backup directory is
 *   the opposite of owner-only — it gets copied to another disk, shipped to
 *   support, kept for months. It was never present during a backup until
 *   backups could be taken hot, so enabling that is what would have started
 *   leaking it.
 * - The in-progress marker is this command's own bookkeeping, and a copy of
 *   it in a restored data directory claims a backup is running there.
 */
const NEVER_COPIED = [PENDING_WRITES_DIRNAME, DAEMON_RECORD_FILENAME, BACKUP_MARKER_FILENAME]

/**
 * The database and everything SQLite keeps beside it.
 *
 * In WAL mode the newest commits live in `whiteboard.db-wal` until a
 * checkpoint folds them back, so the three files are one artifact. Excluding
 * only the main file would leave a `-wal` in the backup holding a fragment of
 * exactly the pre-migration rows the exclusion exists to keep out — and
 * SQLite replays a `-wal` into any database later placed beside it.
 */
function isUnderBlobs(dataDir: string, path: string): boolean {
  const blobs = join(dataDir, 'blobs')
  return path === blobs || path.startsWith(`${blobs}${sep}`)
}

function isDatabaseFile(dataDir: string, path: string): boolean {
  return path === join(dataDir, DB_FILENAME) || path.startsWith(join(dataDir, `${DB_FILENAME}-`))
}

// Copy <srcDataDir> into <backupDir>. The backup is a directory copy,
// not an archive — restore is the inverse copy. `srcDataDir` must
// exist; `backupDir` must be empty (or missing) so a backup never
// silently merges into a stale tree.
export async function backupDataDir(
  srcDataDir: string,
  backupDir: string,
  options: BackupRestoreOptions,
): Promise<void> {
  await assertWithinAllowed(srcDataDir, options, 'source data directory')
  await assertWithinAllowed(backupDir, options, 'backup directory')

  if (!(await dirExists(srcDataDir))) {
    throw new BackupError('Source data directory does not exist.')
  }
  if (!(await isEmptyDirOrMissing(backupDir))) {
    throw new BackupError('Backup directory is not empty.')
  }
  // Reject before copying — copying a symlink would either drop a
  // dangling link into the backup (dereference: false) or eagerly
  // exfiltrate the target into the backup tree. Neither is what the
  // data-dir contract describes.
  await assertNoSymlinks(srcDataDir, 'Source data directory')

  // `recursive: true` copies the tree. `dereference: false` (default)
  // is paired with the symlink rejection above; both layers are kept
  // so a future change to one still leaves the other in place.
  // `errorOnExist: true` belt-and-suspenders against a race: if
  // anyone writes into backupDir between the empty check and the
  // copy, fail closed instead of silently overwriting.
  await cp(srcDataDir, backupDir, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    // Two things are filtered out rather than deleted afterwards: a fossil
    // that is copied and then removed exists on disk in between, and a backup
    // interrupted in that window is one holding rows it was never meant to
    // hold.
    //
    // The staging area never travels, whatever the database is doing. It
    // holds mid-flight bytes under names no digest or file id matches, so a
    // copy of one resolves to nothing — and it is the entry a live copy is
    // most likely to trip over, since `cp` stats each name it listed and a
    // file renamed away in between raises ENOENT for the whole backup.
    filter: (src: string) =>
      !NEVER_COPIED.some((name) => src === join(srcDataDir, name)) &&
      !(options.excludeDatabaseFile === true && isDatabaseFile(srcDataDir, src)) &&
      !(options.excludeBlobs === true && isUnderBlobs(srcDataDir, src)),
  })
}

// Restore <backupDir> into <targetDataDir>. `targetDataDir` must be
// empty (or missing) — failing closed prevents a partial overlay from
// merging stale rows with the backup's authoritative state.
export async function restoreDataDir(
  backupDir: string,
  targetDataDir: string,
  options: BackupRestoreOptions,
): Promise<void> {
  await assertWithinAllowed(backupDir, options, 'backup directory')
  await assertWithinAllowed(targetDataDir, options, 'target data directory')

  if (!(await dirExists(backupDir))) {
    throw new BackupError('Backup directory does not exist.')
  }
  if (!(await isEmptyDirOrMissing(targetDataDir))) {
    throw new BackupError('Target data directory is not empty.')
  }
  // The backup tree may have been produced outside this helper, so
  // re-check the symlink contract at restore time. Without this the
  // restored data dir could carry a symlink that the daemon would
  // dereference on read.
  await assertNoSymlinks(backupDir, 'Backup directory')

  // Read before copying, because it decides what the copy must leave out.
  const references = await readBackupBlobManifest(backupDir)

  await cp(backupDir, targetDataDir, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    // A mirrored backup's own `blobs/`+`files/` are the MIRROR's stores, not
    // a data directory's contents — they are keyed by digest, and `files/`
    // has no meaning in a data dir at all. Copying them would also collide
    // with the materialisation below, which writes each blob to where it
    // actually belongs. A backup with no manifest predates the mirror and
    // carries its real `blobs/` tree, so nothing is excluded there.
    filter: (src: string) =>
      references === null ||
      !MIRROR_STORE_DIRNAMES.some(
        (name) => src === join(backupDir, name) || src.startsWith(join(backupDir, name) + sep),
      ),
  })

  if (references) {
    await materialiseMirroredBlobs(backupDir, targetDataDir, references)
  }
}

const MIRROR_STORE_DIRNAMES = ['blobs', 'files']

/**
 * Put back the blobs the mirror holds on this backup's behalf.
 *
 * Only called for a backup that HAS a manifest. One with none predates the
 * mirror and carries its blobs inside itself, so the copy above already
 * restored them — which is why `readBackupBlobManifest` answers `null` rather
 * than an empty set for that case.
 *
 * Checked before anything is written, not as it goes: a restore that fails
 * halfway leaves a data directory that looks restored and is missing files,
 * and the operator finds out when a document renders a hole. That check is
 * `snapshotIsRestorable`, and ADR-0021 decision 6 names a restore attempt as
 * the moment to call it.
 */
async function materialiseMirroredBlobs(
  backupDir: string,
  targetDataDir: string,
  references: BackupBlobReferences,
): Promise<void> {
  const mirrorRoot = mirrorRootFor(backupDir, references)
  const wanted: Array<{ from: string; to: string }> = []
  for (const digest of references.blobs) {
    wanted.push({
      from: join(mirrorRoot, 'blobs', digest.slice(0, 2), digest.slice(2)),
      to: join(targetDataDir, 'blobs', digest.slice(0, 2), digest.slice(2)),
    })
  }
  for (const [relativePath, digest] of Object.entries(references.files)) {
    wanted.push({
      from: join(mirrorRoot, 'files', digest.slice(0, 2), digest.slice(2)),
      to: join(targetDataDir, 'blobs', ...relativePath.split('/')),
    })
  }

  const missing = (
    await Promise.all(
      wanted.map(async (item) => ((await pathExists(item.from)) ? null : item.from)),
    )
  ).filter((path): path is string => path !== null)
  if (missing.length > 0) {
    throw new BackupError(
      `Backup refers to ${missing.length} blob(s) the mirror does not hold. ` +
        'Restore refused rather than producing a data directory with holes in it.',
    )
  }

  for (const item of wanted) {
    await mkdir(dirname(item.to), { recursive: true })
    await cp(item.from, item.to, { dereference: false, errorOnExist: true, force: false })
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
