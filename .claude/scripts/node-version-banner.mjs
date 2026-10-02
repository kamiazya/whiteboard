// A vitest globalSetup (registered in the root vitest.config.ts) that says,
// once and loudly, when the suite is running on a Node major other than
// `.node-version`.
//
// It exists because the wrong-major failures name neither Node nor the pin,
// and the guard that does (`local-node-version.test.ts`, in `mcp-node`) cannot
// fire for a run scoped to another project. This runs for every project, once
// per run, before any test.
//
// It NEVER throws or fails the run: a sandbox on the wrong major still has to
// run its local gate, and a banner that blocks is a banner that gets removed.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The leading number of a `.node-version`, which may be "24", "v24.1.0" or a full version. */
export function pinnedMajor(text) {
  return /^v?(\d+)/.exec(text.trim())?.[1]
}

/**
 * The banner for a wrong major, or `null` when the major matches or the pin is
 * unreadable. `versions` is a parameter so a test can stub it without touching
 * the real `process.versions`.
 */
export function wrongNodeBanner({ pinned, versions = process.versions }) {
  if (pinned === undefined) return null
  const running = versions.node.split('.')[0]
  if (running === pinned) return null
  const bar = '='.repeat(78)
  return [
    bar,
    `WRONG NODE MAJOR: running Node ${versions.node} (ICU/Unicode ${versions.unicode}); .node-version pins ${pinned}, which is what CI installs.`,
    'Failures on the wrong major name neither Node nor the pin. Known symptoms, none a regression:',
    '  - 9 web-jsdom tests fail with `TypeError: object.stream is not a function` (undici reads Blob.stream()).',
    '  - packages/search snippet.test.ts "honours a Prepend" fails on the Unicode table (ICU/Unicode version).',
    `Switch to Node ${pinned} (nvm/fnm/asdf) and re-run before believing any red.`,
    "The guard for this is packages/mcp-server's local-node-version.test.ts (mcp-node project only); this banner covers every project and never fails the run.",
    bar,
  ].join('\n')
}

export default function setup() {
  try {
    const pinned = pinnedMajor(readFileSync(join(REPO_ROOT, '.node-version'), 'utf8'))
    const banner = wrongNodeBanner({ pinned })
    if (banner !== null) process.stderr.write(`\n${banner}\n\n`)
  } catch {
    // Advisory only: an unreadable pin must not stop the suite it advises.
  }
}
