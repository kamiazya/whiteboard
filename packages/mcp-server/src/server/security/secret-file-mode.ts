/**
 * How this daemon writes a secret to disk, and what it refuses to read back.
 *
 * Both key stores (`daemon-identity.ts`, `macaroon-root-key.ts`) hold a secret
 * whose whole protection is the OS user boundary — each file's header says so
 * explicitly: "a full-privilege local attacker reads the key and is out of
 * scope; the daemon already trusts the OS user boundary." A key file another
 * local user can read is that boundary not holding, so the daemon refuses to
 * start on one rather than carrying on with a secret that may already have
 * been copied. That is ssh's posture for a private key, and it is the only
 * one coherent with the threat model those headers state.
 *
 * Shared rather than duplicated because both call sites want the same
 * JUDGEMENT — "is this secret owner-only, and if not, stop" — not merely
 * because both touch the filesystem.
 */
import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const OWNER_ONLY_FILE = 0o600
const OWNER_ONLY_DIR = 0o700

// Windows mode bits do not express this, so there is nothing to check or to
// enforce; `cli/server-doctor.ts` skips its own permissions check for the
// same reason and says so in the report.
const POSIX_MODES_APPLY = process.platform !== 'win32'

function chmodBestEffort(path: string, mode: number): void {
  if (!POSIX_MODES_APPLY) return
  try {
    chmodSync(path, mode)
  } catch {
    // A filesystem that will not take a chmod cannot be made safer here. The
    // read-side assertion is what refuses to USE such a file, and it runs
    // whatever happened at write time.
  }
}

/**
 * Refuse a secret file that is readable by anyone but its owner.
 *
 * A file that does not exist is not an error: both key stores answer absence
 * by generating a fresh secret, and turning "no key yet" into a startup
 * failure would break first boot.
 */
export function assertSecretFileIsOwnerOnly(filepath: string): void {
  if (!POSIX_MODES_APPLY) return
  let mode: number
  try {
    mode = statSync(filepath).mode
  } catch {
    return
  }
  if ((mode & 0o077) === 0) return
  throw new Error(
    `${filepath} is readable by group or other (mode ${(mode & 0o777).toString(8)}). ` +
      `A daemon secret must be owner-only. Run \`chmod 600 ${filepath}\` and restart.`,
  )
}

/**
 * Write a secret through a temp file and rename it into place, owner-only at
 * every step.
 *
 * The explicit `chmod` calls are the point, and neither is redundant:
 * **`writeFileSync`'s and `mkdirSync`'s `mode` options apply only when the
 * path is CREATED.** A `<file>.tmp` left behind by a crashed write, or a data
 * dir that already existed with wider bits, keeps what it had — and for the
 * temp file the rename then carries those bits onto the secret itself.
 * Measured against Node: a 0o644 file rewritten with `{ mode: 0o600 }` reads
 * back 0o644.
 */
export function writeSecretFileAtomicSync(filepath: string, contents: string): void {
  const dir = dirname(filepath)
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR })
  chmodBestEffort(dir, OWNER_ONLY_DIR)
  const tmpPath = `${filepath}.tmp`
  writeFileSync(tmpPath, contents, { mode: OWNER_ONLY_FILE })
  chmodBestEffort(tmpPath, OWNER_ONLY_FILE)
  renameSync(tmpPath, filepath)
}
