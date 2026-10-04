// Whether a script was started as the entry module, for every plain-Node script in the repo.
//
// `import.meta.url` is percent-encoded and `process.argv[1]` is a raw path, so comparing them as
// strings is false under any checkout whose path holds a space, `#` or `%`. A script guarded that
// way then does nothing and exits 0 — a build "succeeds" with nothing copied, a gate passes with
// nothing checked. `script-entry-check.test.ts` fails any other script that reads `process.argv[1]`.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` is the one node was started on. A script exports its helpers
 * for its test and runs `main()` only when this holds. Both paths are resolved so a symlinked
 * entry still counts.
 *
 * @param {string} moduleUrl the caller's `import.meta.url`
 */
export function isRunAsScript(moduleUrl) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
