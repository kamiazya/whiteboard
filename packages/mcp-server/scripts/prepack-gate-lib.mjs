// The skeleton the `prepack` gates share: run only when node was started on
// the gate itself, fail loudly naming the first missing file, and say nothing
// on stdout.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` is the one node was started on. Compared
 * as resolved filesystem paths: `import.meta.url` is percent-encoded and
 * `process.argv[1]` is not, so comparing them as strings made a checkout whose
 * path contains a space run no gate at all, and `prepack` read that as a pass.
 */
function isEntryModule(moduleUrl) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/**
 * Run a gate when `moduleUrl` is the entry module, and do nothing when a test
 * imported it for its finder.
 *
 * @param {string} moduleUrl the gate's own `import.meta.url`
 * @param {{ find: () => string | null, remedy: string, present: string }} gate
 *   `find` answers the first missing path or null; `remedy` is what to run
 *   about it; `present` names what was found.
 */
export function runPrepackGate(moduleUrl, { find, remedy, present }) {
  if (!isEntryModule(moduleUrl)) return
  const missing = find()
  if (missing) {
    console.error(`prepack gate: ${missing} not found — ${remedy}`)
    process.exit(1)
  }
  // stderr, not stdout: npm interleaves lifecycle-script stdout with the
  // `npm pack --json` payload, so anything printed here on stdout corrupts
  // JSON consumers of the pack output (e.g. the release pack-contents check).
  console.error(`prepack gate: ${present} — OK`)
}
