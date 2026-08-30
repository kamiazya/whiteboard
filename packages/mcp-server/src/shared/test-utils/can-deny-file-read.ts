/**
 * Whether this process can be denied read access to a file it owns.
 *
 * A test that asserts EACCES handling has to make something unreadable
 * first, and `chmod 000` does not do that for every process: root reads it
 * anyway (and so does Windows, where the mode is close to meaningless). The
 * test then fails on its own premise — the code under it never gets the error
 * it exists to handle — and the failure reads as a broken error path.
 *
 * Measured in one container: three `mcp-node` tests failed for a whole
 * session and were written off as "environment", which was true and useless.
 * `expected undefined to be an instance of Error` says nothing about uid.
 *
 * PROBED, never inferred. `process.getuid?.() === 0` is the tempting version
 * and it is a guess about a mechanism — capabilities, a read-only mount, a
 * container's user namespace and Windows all decide this independently of the
 * uid. So this actually writes a file, closes it off, and tries to read it.
 *
 * Resolved once at module load: the answer cannot change during a run, and
 * `it.skipIf` needs it at collection time.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function probe(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'wb-deny-read-'))
  const file = join(dir, 'closed-off')
  try {
    writeFileSync(file, 'x')
    chmodSync(file, 0o000)
    try {
      readFileSync(file)
      // The mode was set and the read still succeeded, so nothing here can be
      // made unreadable to us.
      return false
    } catch {
      return true
    }
  } finally {
    // Restore before removing: a directory holding a mode-000 file is fine to
    // unlink, but leaving one behind in tmp is rude either way.
    try {
      chmodSync(file, 0o644)
    } catch {
      // Already gone, or never created — rm below is what matters.
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

export const CAN_DENY_FILE_READ = probe()
