/**
 * Whether a mode this process SETS is a mode it READS BACK.
 *
 * PROBED, never inferred: Windows mode bits are close to meaningless and some
 * mounts drop chmod entirely, and a test whose premise the filesystem cannot
 * establish reports a broken guard rather than an unavailable one. This is
 * NOT the root question `can-deny-file-read.ts` answers — the secret-file
 * guards read `statSync().mode` instead of attempting a denied read, so uid 0
 * changes nothing here.
 *
 * Resolved once at module load: the answer cannot change during a run, and
 * `it.skipIf` needs it at collection time.
 */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function probe(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-mode-probe-'))
  try {
    const file = join(probeDir, 'f')
    writeFileSync(file, 'x')
    chmodSync(file, 0o644)
    return (statSync(file).mode & 0o777) === 0o644
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

export const CHMOD_IS_OBSERVABLE: boolean = probe()
