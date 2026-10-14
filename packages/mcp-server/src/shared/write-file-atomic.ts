import { randomUUID } from 'node:crypto'
import { chmod, open, rename, rm } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname } from 'node:path'
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
  try {
    const staged = await open(tempPath, 'w', mode)
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
 * Errors that say a directory cannot be synced here at all — Windows cannot
 * open one, and some filesystems refuse fsync on it — rather than that the
 * sync failed. Anything else (EIO, ENOSPC) means the rename may not be
 * durable, and the write must not report success.
 */
const DIRECTORY_SYNC_UNSUPPORTED: ReadonlySet<string | undefined> = new Set([
  'EISDIR',
  'EPERM',
  'EACCES',
  'EINVAL',
  'ENOTSUP',
  'EBADF',
])

const cannotSyncDirectory = (err: unknown): boolean =>
  DIRECTORY_SYNC_UNSUPPORTED.has(errnoCode(err))

async function syncDirectory(path: string): Promise<void> {
  let dir: Awaited<ReturnType<typeof open>>
  try {
    dir = await open(path, 'r')
  } catch (err) {
    if (cannotSyncDirectory(err)) return
    throw err
  }
  try {
    await dir.sync()
  } catch (err) {
    if (!cannotSyncDirectory(err)) throw err
  } finally {
    await dir.close()
  }
}
