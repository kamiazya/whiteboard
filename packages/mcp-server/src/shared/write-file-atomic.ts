import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync } from 'node:fs'
import { chmod, open, readdir, rename, rm } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { errnoCode } from './errno.js'

/**
 * Write `data` to `path` so no reader ever sees it half-written, and so a
 * crash cannot leave the name on bytes that never reached the disk.
 *
 * Staged beside the target under a unique `.partial` name, then committed by
 * `commitStagedWrite`. The name is unique per call so two writers of the same
 * target cannot interleave into one buffer, and it never matches a content
 * address, so a directory scan that keys on those ignores a leftover.
 *
 * Durable exactly as `writeFileAtomicStaged` in `server/atomic-write.ts` is —
 * both commit through the same tail. They differ only in WHERE they stage:
 * that one stages under a data dir's excluded directory so a backup walk
 * never meets a staged name; this one stages beside the target, so the
 * target need not live under a data dir.
 *
 * `mode` is applied to the staged file before the rename, so the target never
 * appears with a looser one; the open's own mode is masked by the umask and
 * can come out tighter than asked, hence the explicit chmod. Windows ignores
 * POSIX modes and relies on ACLs.
 */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  options: { mode?: number } = {},
): Promise<void> {
  await commitStagedWrite(`${path}.${randomUUID()}.partial`, path, data, options)
}

/**
 * Write `data` to `tempPath`, make it durable, and rename it onto
 * `targetPath`; the one tail every atomic writer in this package shares.
 *
 * The staged bytes are fsynced before the rename: a filesystem need not order
 * a new file's data before a rename of it, so without the sync a crash can
 * leave the final name on a zero-length file — complete-looking, holding
 * nothing. The target directory is then synced so the rename itself
 * survives; that half tolerates a platform that cannot sync a directory at
 * all, but not a storage error. A staged file never outlives a failure.
 *
 * `tempPath` must be on the same filesystem as `targetPath`, which is what
 * makes the rename atomic.
 */
export async function commitStagedWrite(
  tempPath: string,
  targetPath: string,
  data: Uint8Array | string,
  options: { mode?: number } = {},
): Promise<void> {
  const { mode } = options
  // 'wx' creates or fails: a file or symlink already at the staged name is
  // never truncated or followed, and — not being ours — never removed below.
  const staged = await open(tempPath, 'wx', mode)
  try {
    try {
      await staged.writeFile(data)
      if (mode !== undefined && platform() !== 'win32') {
        try {
          await chmod(tempPath, mode)
        } catch {
          /* Best-effort: the open itself already carried the mode. */
        }
      }
      await staged.sync()
    } finally {
      await staged.close()
    }
    await rename(tempPath, targetPath)
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
  await syncDirectory(dirname(targetPath))
}

/**
 * Errors that say a handle cannot be synced here at all — Windows cannot open
 * a directory or fsync a read-only file, and some filesystems refuse fsync on
 * a directory — rather than that the sync failed. Anything else (EIO, ENOSPC) means the rename may not be
 * durable, and the write must not report success.
 */
const SYNC_UNSUPPORTED: ReadonlySet<string | undefined> = new Set([
  'EISDIR',
  'EPERM',
  'EACCES',
  'EINVAL',
  'ENOTSUP',
  'EBADF',
])

const cannotSyncHere = (err: unknown): boolean => SYNC_UNSUPPORTED.has(errnoCode(err))

/**
 * Sync a directory, so a rename into or out of it survives a crash. Forgives
 * only a platform that cannot sync a directory at all, never a storage error.
 */
export async function syncDirectory(path: string): Promise<void> {
  await syncPath(path)
}

async function syncPath(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (err) {
    if (cannotSyncHere(err)) return
    throw err
  }
  try {
    await handle.sync()
  } catch (err) {
    if (!cannotSyncHere(err)) throw err
  } finally {
    await handle.close()
  }
}

/**
 * Sync every regular file and directory beneath `root`, and `root` itself,
 * for a caller about to rename the whole tree into place: renaming a
 * directory orders none of the data inside it, so without this a crash can
 * leave the final name over files that are zero-length.
 *
 * Files are opened read-only, which is enough for fsync on POSIX; where the
 * platform refuses that (Windows wants a writable handle) it is forgiven
 * under the same tolerance as a directory, and a storage error still throws.
 * Directories are synced longest path first — a child's path is always
 * longer than its parent's — so each one's entries are durable before its
 * parent's are. Symbolic links are not followed.
 */
export async function syncTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  const dirs: string[] = []
  // One fsync at a time: the caller is a backup, which runs in its own
  // process where wall time is not what it lacks.
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name)
    if (entry.isFile()) await syncPath(path)
    else if (entry.isDirectory()) dirs.push(path)
  }
  dirs.sort((a, b) => b.length - a.length)
  // Sequential, not parallel: the child-before-parent order is the point.
  for (const dir of dirs) await syncPath(dir)
  await syncPath(root)
}

/**
 * `syncDirectory` for a caller that must stay synchronous (a secret written
 * during boot), under the same tolerance: only "cannot sync a directory
 * here" is forgiven, never a storage error.
 */
export function syncDirectorySync(path: string): void {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    if (cannotSyncHere(err)) return
    throw err
  }
  try {
    fsyncSync(fd)
  } catch (err) {
    if (!cannotSyncHere(err)) throw err
  } finally {
    closeSync(fd)
  }
}
