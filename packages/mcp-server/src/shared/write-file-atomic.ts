import { randomUUID } from 'node:crypto'
import { chmod, rename, rm, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'

/**
 * Write `data` to `path` so no reader ever sees it half-written.
 *
 * Staged beside the target under a unique `.partial` name and renamed, which
 * is atomic within one filesystem. The name is unique per call so two writers
 * of the same target cannot interleave into one buffer, and it never matches
 * a content address, so a directory scan that keys on those ignores a
 * leftover. For a write that must stage under a data dir's excluded
 * directory instead, see `server/atomic-write.ts`.
 *
 * `mode` is applied to the staged file before the rename, so the target never
 * appears with a looser one; `writeFile`'s own mode is masked by the umask and
 * can come out tighter than asked, hence the explicit chmod. Windows ignores
 * POSIX modes and relies on ACLs.
 */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  options: { mode?: number } = {},
): Promise<void> {
  const { mode } = options
  const temp = `${path}.${randomUUID()}.partial`
  try {
    await writeFile(temp, data, mode === undefined ? undefined : { mode })
    if (mode !== undefined && platform() !== 'win32') {
      try {
        await chmod(temp, mode)
      } catch {
        /* Best-effort: the write itself already carried the mode. */
      }
    }
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
}
