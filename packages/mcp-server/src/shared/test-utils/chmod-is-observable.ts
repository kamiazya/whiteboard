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

/**
 * Throws when the probe cannot run. A tmpdir that cannot be written, or a
 * chmod that errors, is not an answer of "modes are unobservable": reading it
 * that way would skip every test it gates and report green, so the setup
 * failure surfaces instead. `false` is only for a chmod that succeeded and
 * did not stick. `chmod` is a parameter so that distinction can be tested.
 */
export function probeChmodIsObservable(chmod: typeof chmodSync = chmodSync): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-mode-probe-'))
  try {
    const file = join(probeDir, 'f')
    writeFileSync(file, 'x')
    // Two distinct modes, because a file is born with whatever the umask
    // leaves: a chmod that does nothing reads back as the one mode it
    // happened to be created with, and can match at most one of the two.
    return [0o600, 0o644].every((mode) => {
      chmod(file, mode)
      return (statSync(file).mode & 0o777) === mode
    })
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

export const CHMOD_IS_OBSERVABLE: boolean = probeChmodIsObservable()
