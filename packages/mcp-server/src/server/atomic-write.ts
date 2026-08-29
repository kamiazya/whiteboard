import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Where bytes sit between being written and being renamed into place.
 *
 * One directory at the top of the data dir, rather than a temp file beside
 * each target, for two reasons. Excluding it from a backup is a single path
 * instead of a filename pattern several modules have to agree on; and `cp`
 * stats each entry it listed, so a temp file renamed away in between raises
 * ENOENT and aborts the WHOLE backup — measured, before this moved out of the
 * blob shards.
 *
 * Nothing in here is content. These are mid-flight bytes under names no
 * digest or file id matches, and a copy of one resolves to nothing.
 */
export const PENDING_WRITES_DIRNAME = '.pending-writes'

/**
 * Write `bytes` to `targetPath` so no reader ever sees it half-written.
 *
 * A plain `writeFile` opens with O_TRUNC and leaves the target short for the
 * whole duration of the write, which is not a narrow race — the window is as
 * long as the write. Measured on the two call sites this replaces: a blob
 * re-put made an existing blob unreadable in 8 reads out of 8, and a backup
 * copy overlapping an in-flight upload captured a torn file 2 times out of 10.
 *
 * `rename` within one filesystem is atomic, so a reader sees either the
 * previous complete file or the new one. The staging directory is under the
 * same data dir as every target, which is what makes that hold.
 */
export async function writeFileAtomic(
  dataDir: string,
  targetPath: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const stagingDir = join(dataDir, PENDING_WRITES_DIRNAME)
  await mkdir(stagingDir, { recursive: true })
  const tempPath = join(stagingDir, randomUUID())
  try {
    await writeFile(tempPath, bytes)
    await rename(tempPath, targetPath)
  } catch (err) {
    // Never leave a staged file behind: the directory is excluded from
    // backups but it is still the operator's disk.
    await rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
}
