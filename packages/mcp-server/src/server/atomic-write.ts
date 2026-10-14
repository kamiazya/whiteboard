import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { commitStagedWrite } from '../shared/write-file-atomic.js'

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
 * Write `bytes` to `targetPath` so no reader ever sees it half-written, and so
 * a crash cannot leave the name on bytes that never reached the disk.
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
 *
 * Durable exactly as `shared/write-file-atomic.ts`'s `writeFileAtomic` is —
 * both commit through `commitStagedWrite`, which fsyncs the staged bytes
 * before the rename and the directory after it. They differ only in WHERE
 * they stage: this one under the data dir's excluded directory, so the staged
 * name never appears in what a backup walks; that one beside the target, for
 * a target that need not live under a data dir. Use this one for content
 * inside the data dir that a backup copies.
 */
export async function writeFileAtomicStaged(
  dataDir: string,
  targetPath: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const stagingDir = join(dataDir, PENDING_WRITES_DIRNAME)
  await mkdir(stagingDir, { recursive: true })
  // A failure removes the staged file: the directory is excluded from
  // backups but it is still the operator's disk.
  await commitStagedWrite(join(stagingDir, randomUUID()), targetPath, bytes)
}
