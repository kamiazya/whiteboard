import { cp, lstat, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

// Backup / restore drill helper for the local daemon data directory.
//
// Layout the data dir is expected to carry (see store/db, canvas-store,
// version-store, routes/files, user-library-store):
//   <data>/whiteboard.db                                   libsql DB
//                                                          (workspaces, canvases, versions
//                                                           metadata + frontiers, branches,
//                                                           palette, libraries, runtime)
//   <data>/<workspaceId>/files/<fileId>.<ext>              binary file blobs (image attachments)
//   <data>/blobs/<workspaceId>/canvas/<canvasId>.loro      Loro canvas snapshot
//   <data>/blobs/<workspaceId>/versions/<versionId>.png    optional version thumbnail
//   <data>/blobs/.user-libraries/*.excalidrawlib           user libraries
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
  constructor(message: string) {
    super(message)
  }
}

export interface BackupRestoreOptions {
  // The full set of absolute path prefixes the helper is allowed to
  // read from / write to. Every src + dest in a backup or restore
  // must canonicalize inside one of them. Tests pass their temp dir.
  // The runtime caller (e.g. a future support-bundle CLI) would pass
  // the user data dir + a sibling backup dir.
  allowedRoots: string[]
}

// Canonicalize `p` by resolving symlinks on the deepest existing ancestor.
// `resolve()` does NOT follow symlinks, so an ancestor symlink (e.g.
// `<allowed>/link → /outside`) passes a plain resolve()-based prefix check
// while actually pointing outside the allowed tree. `realpath` on the deepest
// existing ancestor fixes that.
//
// Exported so CLI callers can canonicalize user-supplied paths before
// passing them to helpers, ensuring the `allowedRoots` guard sees real paths.
export async function canonicalizePath(p: string): Promise<string> {
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

  await cp(backupDir, targetDataDir, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  })
}
