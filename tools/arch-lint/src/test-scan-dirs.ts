import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './scan-roots.js'

/** Where this monorepo keeps its workspace packages, per `pnpm-workspace.yaml`. */
const WORKSPACE_ROOTS = ['apps', 'packages', 'tools'] as const

/** Build output and tooling caches, which hold copies of what `src` already holds. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'tmp', '.vite', '.vitest'])

/**
 * Every workspace package, for scans ABOUT test files (titles, sleeps,
 * viewport helpers).
 *
 * DERIVED, because the hand-kept list of `<package>/src` directories this
 * replaced went stale in the two ways such a list does, and both were
 * invisible: a package created after it was written was never added
 * (`daemon-client` 29 files, `history` 3, `scene` 1), and a test file kept
 * anywhere but `src` was never covered at all (17 more — `apps/web`'s own
 * root 9, its `scripts/` 7, `mcp-server`'s root 1; `mcp-server/scripts` was
 * the single such directory anyone had remembered to add). 1568 tracked
 * test files covered, 1618 in the workspace.
 *
 * A scan over a directory that holds none of what it is looking for reports
 * exactly what a scan that checked and found nothing reports.
 */
export const TEST_SCAN_DIRS: readonly string[] = WORKSPACE_ROOTS.flatMap((root) =>
  readdirSync(join(REPO_ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${root}/${entry.name}`)
    .filter((dir) => existsSync(join(REPO_ROOT, dir, 'package.json'))),
).sort()

function walk(dir: string, keep: (full: string, name: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(full, keep))
      continue
    }
    if (keep(full, entry.name)) files.push(full)
  }
  return files
}

export function listTestFiles(dir: string): string[] {
  return walk(dir, (_full, name) => /\.test\.(ts|tsx)$/.test(name))
}

/**
 * The non-test files that RUN inside tests: anything under a `test-utils`
 * directory, and a shared behavioural suite (`*-contract.ts`, `*.contract.ts`)
 * that several test files call into. A sleep in one of these is paid by every
 * caller, and it is invisible to a scan that only reads `*.test.ts(x)`.
 *
 * A separate list from `listTestFiles` rather than a wider predicate there:
 * the title, lazy-import and viewport scans read what a test file DECLARES,
 * and a helper declares no tests, so widening them would change what they
 * govern instead of what they see.
 */
export function listTestHelperFiles(dir: string): string[] {
  return walk(dir, (full, name) => {
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return false
    return /[-.]contract\.tsx?$/.test(name) || /[\\/]test-utils[\\/]/.test(full)
  })
}
