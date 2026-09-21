/**
 * `daemon-client` reaches `server-core` through a SUBPATH, never its root
 * barrel.
 *
 * The root barrel is `createServer` and everything under it — hono,
 * loro-crdt, canvas-render, search — and `daemon-client` is the half of the
 * daemon that runs in a browser. What a re-export DRAGS is invisible to
 * every other guard here: the boundary scans see one package importing
 * another it is allowed to depend on, and the type system sees a schema.
 * Only a built bundle can see the rest, and only after a build.
 *
 * Twice measured, both times in gzipped critical-path JS against a 152 KB
 * budget:
 *
 * - `pairing.ts` imported the root for one schema — 144.5 KB in 27 files
 *   became 413.8 KB in 31, loro's WASM bindings included. `daemon-client`
 *   is `sideEffects: false`, so a module the critical path never needs is
 *   dropped whole; one it DOES need keeps every import it makes, and
 *   server-core's root is not side-effect-free to the bundler.
 * - `error-copy.ts` took `apiErrorReason` from the root instead of
 *   `/api-errors` — 421.4 KB, a 269 KB difference for one enum.
 *
 * Both were caught by `smoke:bundle-size`, after a production build, on CI.
 * This scan is the same rule at pre-push and three orders of magnitude
 * cheaper.
 *
 * It replaces daemon-client's own server-core-root-imports test (deleted,
 * so its name is unbackticked here: a backticked name is a POINTER and
 * comment-file-pointers.test.ts resolves every one),
 * which is where those measurements were recorded. That one pinned WHICH
 * modules could import the root, by equality, and it was narrower than the
 * rule in three ways, each of which this one closes: it globbed
 * `api-contracts/*.ts` alone rather than the package; it never stripped
 * comments, so after the last real import left `index.ts` it went on
 * passing on the strength of the PROSE explaining why the root is wrong;
 * and it lived in a project a change to this package does not have to run,
 * while the whole of `arch-lint-node` runs at push.
 *
 * The allowance is retired rather than moved: nothing imports the root now,
 * so "off the critical path today" — a property of who imports a module
 * rather than a guarantee about it — no longer has to be anybody's
 * judgement call.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const DAEMON_CLIENT_SRC = join(REPO_ROOT, 'packages', 'daemon-client', 'src')

const ROOT_IMPORT = /from\s+'@kamiazya\/whiteboard-server-core'/

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full))
      continue
    }
    if (/\.tsx?$/.test(entry.name)) files.push(full)
  }
  return files
}

describe('daemon-client reaches server-core through a subpath', () => {
  it('scans a real population', () => {
    const files = sourceFiles(DAEMON_CLIENT_SRC)
    expect(files.length).toBeGreaterThan(40)
    // The subject is present: this package really does import server-core.
    const importers = files.filter((file) =>
      readFileSync(file, 'utf-8').includes('@kamiazya/whiteboard-server-core/'),
    )
    expect(importers.length).toBeGreaterThan(2)
  })

  it('imports the root barrel nowhere', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(DAEMON_CLIENT_SRC)) {
      const source = readFileSync(file, 'utf-8')
      for (const [index, line] of source.split('\n').entries()) {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue
        }
        if (ROOT_IMPORT.test(line)) {
          offenders.push(`${relative(REPO_ROOT, file).split(sep).join('/')}:${index + 1}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
