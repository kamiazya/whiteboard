import type { Stats } from 'node:fs'
import { cp, lstat, mkdir, readdir, readlink, stat } from 'node:fs/promises'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { DAEMON_RECORD_FILENAME } from '../daemon/daemon-registry.js'
import { NATIVE_HOST_DIRNAME } from '../daemon/native-host/install.js'
import { isMissingFileError } from '../shared/errno.js'
import { canonicalizeWithMissingTail, isWithinAllowedRoots } from '../shared/path-containment.js'
import { PENDING_WRITES_DIRNAME } from './atomic-write.js'
import { SEARCH_MODELS_DIRNAME } from './search/model-cache-dir.js'
import { DAEMON_IDENTITY_FILENAME } from './security/daemon-identity.js'
import { MACAROON_ROOT_KEY_FILENAME } from './security/macaroon-root-key.js'
import type { BackupBlobReferences } from './store/backup-blob-mirror.js'
import { mirrorRootFor, readBackupBlobManifest } from './store/backup-blob-mirror.js'
import { BACKUP_MARKER_FILENAME } from './store/backup-in-progress.js'
import { DB_FILENAME } from './store/db/location.js'
import {
  BLOBS_DIRNAME,
  blobShardPath,
  blobsRoot,
  FILES_DIRNAME,
  isAnyTenantBlobsPath,
} from './tenant/data-layout.js'

// Backup / restore drill helper for the local daemon data directory.
//
// Layout the data dir is expected to carry (see store/db, document-store,
// version-store, routes/files):
//   <data>/whiteboard.db                                   libsql DB
//                                                          (workspaces, documents, versions
//                                                           metadata + frontiers,
//                                                           runtime)
//   <data>/<workspaceId>/files/<fileId>.<ext>              binary file blobs (image attachments)
//   <data>/blobs/<workspaceId>/document/<documentId>.loro      Loro document snapshot
// Per-version `.loro` files are NOT written — version state is captured by
// frontiers in the DB plus the live document snapshot.
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

// Resolve `p` one component at a time, the way the kernel would, and return
// true when the path's own final component is a symbolic link, or any link the
// resolution passes through is one someone other than root or this user could
// have placed. `inspectOutputPath` and `isSafeSourcePath` fail closed on it, so
// a planted link (e.g. `<shared>/link → /outside`) cannot redirect a read or
// write outside the operator's intended storage zone.
//
// Each link is judged by the REAL directory holding it, not the one the path
// spells: a link reached through another link's target sits wherever that
// target resolved to, so a trusted `~/out → <shared>/planted` must not vouch
// for the planted link behind it.
//
// An intermediate link is not refused outright because operating systems ship
// them where nobody else can write: macOS's `/tmp → /private/tmp` and
// `/var → /private/var` sit in a root-owned `/` that no one else may write, so
// refusing every link would refuse the temp directory itself.
async function hasUntrustedSymlink(p: string): Promise<boolean> {
  const target = resolve(p)
  const { root } = parse(target)
  let real = root
  const pending = pathComponents(target.slice(root.length))
  let hops = 0
  while (pending.length > 0) {
    const name = pending.shift() as string
    if (name === '..') {
      real = dirname(real)
      continue
    }
    const candidate = join(real, name)
    const st = await lstatIfPresent(candidate)
    // Nothing below a missing component exists either, so no link remains.
    if (st === undefined) return false
    if (!st.isSymbolicLink()) {
      real = candidate
      continue
    }
    // Only the original final component can leave `pending` empty: a link
    // anywhere above it still has that component queued behind its target.
    if (pending.length === 0 || !(await isTrustedLinkParent(real))) return true
    hops += 1
    if (hops > MAX_SYMLINK_HOPS) return true
    const linkTarget = await readlink(candidate)
    const targetRoot = parse(linkTarget).root
    if (targetRoot) real = targetRoot
    pending.unshift(...pathComponents(linkTarget.slice(targetRoot.length)))
  }
  return false
}

// `..` is kept as a component rather than collapsed lexically: it climbs from
// wherever the walk has REALLY reached, which a link before it may have moved.
function pathComponents(p: string): string[] {
  return p.split(sep).filter((name) => name !== '' && name !== '.')
}

async function lstatIfPresent(p: string): Promise<Stats | undefined> {
  try {
    return await lstat(p)
  } catch (err) {
    if (isMissingFileError(err)) return undefined
    throw err
  }
}

// Linux's own limit (`MAXSYMLINKS`), past which the kernel answers ELOOP; a
// chain that long, or a loop, is refused rather than followed.
const MAX_SYMLINK_HOPS = 40

async function isTrustedLinkParent(dir: string): Promise<boolean> {
  const currentUid = process.getuid?.()
  if (currentUid === undefined) return false
  return trustsLinkParent(await stat(dir), currentUid)
}

/**
 * Whether only root or the user `currentUid` could have created an entry in
 * a directory with this owner and mode: it is owned by one of them and
 * neither group- nor other-writable. A sticky bit does not help — in a sticky
 * `/tmp` anyone may still add a NEW link. Where there are no POSIX owners to
 * ask (`currentUid` undefined: Windows has no `process.getuid`) no directory
 * is trusted, so every symlink in the path is refused there.
 *
 * Pure, so the owner half can be checked by a process that cannot stage a
 * directory another user owns.
 */
export function trustsLinkParent(
  dir: { readonly uid: number; readonly mode: number },
  currentUid: number | undefined,
): boolean {
  if (currentUid === undefined) return false
  return (dir.uid === 0 || dir.uid === currentUid) && (dir.mode & 0o022) === 0
}

export type OutputPathState = 'missing' | 'present' | 'unsafe'

/**
 * Judge a path a command is about to WRITE to, before any byte moves. A
 * symlinked ancestor (`<shared>/link -> /outside`) would redirect the write
 * outside the operator's intended storage zone, so one that someone other
 * than root or this user could have placed is refused — including one reached
 * through an earlier link's target; a link in a directory only they can write
 * (macOS's `/tmp -> /private/tmp`) is followed.
 *
 * What the final component may be is the one thing callers differ on: a
 * backup or restore target refuses a symlink or plain file and lets anything
 * else through to its own emptiness check, while the support bundle writes
 * into a directory and so also refuses every other kind (`requireDirectory`).
 *
 * Throws on anything but a missing component; callers answer that as a
 * failure, never as a refusal, so an unreadable path is not mistaken for an
 * unsafe one.
 */
export async function inspectOutputPath(
  p: string,
  options: { requireDirectory: boolean },
): Promise<OutputPathState> {
  if (await hasUntrustedSymlink(p)) return 'unsafe'
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(p)
  } catch (err) {
    if (isMissingFileError(err)) return 'missing'
    throw err
  }
  const refused = options.requireDirectory ? !st.isDirectory() : st.isSymbolicLink() || st.isFile()
  return refused ? 'unsafe' : 'present'
}

/**
 * The read-side twin: a symlinked source directory would let a command read
 * from outside the allowed zone. Fail-closed, so a path that cannot be
 * examined is not safe either.
 */
export async function isSafeSourcePath(p: string): Promise<boolean> {
  try {
    return !(await hasUntrustedSymlink(p))
  } catch {
    return false
  }
}

async function assertWithinAllowed(
  target: string,
  options: BackupRestoreOptions,
  label: string,
): Promise<void> {
  if (await isWithinAllowedRoots(await canonicalizeWithMissingTail(target), options.allowedRoots)) {
    return
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
    if (isMissingFileError(err)) return true
    throw err
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await lstat(dir)
    return s.isDirectory()
  } catch (err) {
    if (isMissingFileError(err)) return false
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
 * - The daemon record holds the Bearer token the daemon authenticates its HTTP
 *   routes and sync stream with, which is why it is written owner-only. A backup directory is
 *   the opposite of owner-only — it gets copied to another disk, shipped to
 *   support, kept for months. It was never present during a backup until
 *   backups could be taken hot, so enabling that is what would have started
 *   leaking it.
 * - The macaroon root key is the secret every act-plane token chains from
 *   (ADR-0043), and a restore does NOT rotate it — so a backup holding it
 *   lets whoever has the backup mint a macaroon with any scopes that
 *   verifies against the LIVE daemon. It costs only reissuance to lose,
 *   which `macaroon-root-key.ts` already calls the expected price of
 *   regeneration, so the exclusion is cheap and the leak is not.
 * - The daemon's Ed25519 private key is the source of its `did:key`, the
 *   actor its saved versions name, and the key ADR-0035's checkpoint
 *   signatures would sign with. Excluding it is the one exclusion here with
 *   a real cost: a restored daemon generates a fresh identity, so its
 *   did:key changes, every pin on the old key must be retaken, and versions
 *   saved before the restore name an actor the daemon no longer answers to.
 *   That cost is accepted because it is RECOVERABLE — old rows are read as
 *   history — while a private key sitting in a backup is an impersonation
 *   capability that outlives the machine it came from, and that is not.
 *   Encrypting the backup under a passphrase is the answer that keeps both,
 *   and it is a feature rather than a list entry.
 * - The in-progress marker is this command's own bookkeeping, and a copy of
 *   it in a restored data directory claims a backup is running there.
 * - The search model cache is ~113 MB of downloaded weights, copied into
 *   every backup times retention otherwise. Losing it costs semantic ranking
 *   only: the daemon never downloads, so search stays lexical until
 *   `whiteboard search fetch-model` is run again.
 * - The native-host launcher names the data directory and node binary it was
 *   installed for, and a restore always lands in a fresh directory, so a copy
 *   would relay the extension to the old one. `native-host install` rewrites it.
 *
 * This list is the exclusion; `backup-secret-surface.test.ts` is what makes
 * a file ADDED to the data dir answer for itself, because the copy is
 * recursive and the default is therefore "copied". The macaroon key was
 * copied for exactly as long as it existed, which is how that ledger earned
 * its place.
 */
const NEVER_COPIED = [
  PENDING_WRITES_DIRNAME,
  DAEMON_RECORD_FILENAME,
  MACAROON_ROOT_KEY_FILENAME,
  DAEMON_IDENTITY_FILENAME,
  BACKUP_MARKER_FILENAME,
  SEARCH_MODELS_DIRNAME,
  NATIVE_HOST_DIRNAME,
]

/**
 * Exported for `backup-secret-surface.test.ts`, which classifies every file
 * the daemon writes into its data directory against this list. The list is
 * the exclusion; the ledger is what makes adding a file to the data dir ask
 * whether it belongs in a backup, since the copy is recursive and the default
 * is therefore "copied".
 */
export const NEVER_COPIED_FOR_TESTS: readonly string[] = NEVER_COPIED

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
  // ANY tenant's: the copy skips what the mirror holds, and the mirror holds
  // every tenant's blobs. Skipping one tenant's would copy the others whole
  // into each backup — the cost ADR-0021 decision 5 exists to avoid.
  return isAnyTenantBlobsPath(dataDir, path)
}

function isDatabaseFile(dataDir: string, path: string): boolean {
  return path === join(dataDir, DB_FILENAME) || path.startsWith(join(dataDir, `${DB_FILENAME}-`))
}

// Copy <srcDataDir> into <backupDir>. The backup is a directory copy,
// not an archive — restore is the inverse copy. `srcDataDir` must
// exist; `backupDir` must be empty (or missing) so a backup never
// silently merges into a stale tree.
/**
 * Copy a directory's CONTENTS into an existing-or-missing destination.
 *
 * `cp(src, dst, { errorOnExist, force: false })` rejects the destination
 * DIRECTORY itself when it exists, not merely a colliding entry inside it —
 * so it contradicts the empty-dir contract both callers check just above.
 * A mounted volume is always an existing empty directory, which is how a
 * `docker run -v /backups/today:/backup` backup failed every time, with a
 * raw `ERR_FS_CP_EEXIST` rather than a `BackupError`.
 *
 * Copying each top-level entry separately keeps `errorOnExist`'s real job —
 * failing closed if anyone writes a colliding entry between the empty check
 * and the copy — while letting the destination root already be there. It
 * also leaves the destination's own mode and owner alone, which is what a
 * mount point needs.
 */
async function copyDirContents(
  src: string,
  dst: string,
  options: { filter: (path: string) => boolean },
): Promise<void> {
  await mkdir(dst, { recursive: true })
  for (const name of await readdir(src)) {
    const from = join(src, name)
    if (!options.filter(from)) continue
    await cp(from, join(dst, name), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      filter: options.filter,
    })
  }
}

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
  await copyDirContents(srcDataDir, backupDir, {
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

  await copyDirContents(backupDir, targetDataDir, {
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

const MIRROR_STORE_DIRNAMES = [BLOBS_DIRNAME, FILES_DIRNAME]

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
 * and the operator finds out when a document renders a hole. ADR-0021
 * decision 6 names a restore attempt as the moment to check, and the check is
 * the `pathExists` pass below over everything the manifest says the mirror
 * must hold. `snapshotIsRestorable` states the same containment over id sets
 * and is what the retention property tests hold; this path asks the
 * filesystem, so it does not call it.
 */
async function materialiseMirroredBlobs(
  backupDir: string,
  targetDataDir: string,
  references: BackupBlobReferences,
): Promise<void> {
  const mirrorRoot = mirrorRootFor(backupDir, references)
  // The mirror is flat and the manifest says whose each blob is, so every
  // tenant's bytes go back under that tenant rather than into one of them.
  const wanted = Object.entries(references.tenants).flatMap(([tenantId, refs]) =>
    plannedRestores(mirrorRoot, targetDataDir, tenantId, refs),
  )

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

/**
 * Where each of one tenant's blobs and named files goes.
 *
 * Containment is the manifest schema's alone (`readBackupBlobManifest` is the
 * only constructor of `BackupBlobReferences` from untrusted bytes): a tenant id
 * is one path segment and a file path is relative with no `.`, `..`, empty
 * segment or backslash, so every destination below is inside the tenant's blob
 * directory by construction. The target is empty and the restored tree has
 * been checked symlink-free, so no existing link can redirect one either.
 */
function plannedRestores(
  mirrorRoot: string,
  targetDataDir: string,
  tenantId: string,
  refs: BackupBlobReferences['tenants'][string],
): Array<{ from: string; to: string }> {
  const into = blobsRoot(targetDataDir, tenantId)
  const planned = [...refs.blobs].map((digest) => ({
    from: blobShardPath(join(mirrorRoot, BLOBS_DIRNAME), digest),
    to: blobShardPath(into, digest),
  }))
  const named = Object.entries(refs.files).map(([relativePath, digest]) => ({
    from: blobShardPath(join(mirrorRoot, FILES_DIRNAME), digest),
    to: join(into, ...relativePath.split('/')),
  }))
  return [...planned, ...named]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
