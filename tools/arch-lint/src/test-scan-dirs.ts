import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

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
 *
 * `test-lazy-import-check.test.ts` predates this and keeps its own narrower
 * list, with the exemptions measured against it.
 */
export const TEST_SCAN_DIRS: readonly string[] = WORKSPACE_ROOTS.flatMap((root) =>
  readdirSync(join(REPO_ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${root}/${entry.name}`)
    .filter((dir) => existsSync(join(REPO_ROOT, dir, 'package.json'))),
).sort()

export function listTestFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTestFiles(full))
      continue
    }
    if (/\.test\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}
