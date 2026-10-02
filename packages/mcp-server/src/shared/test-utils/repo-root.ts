import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

/**
 * The nearest ancestor of `startDir` (itself included) holding `marker`.
 *
 * `pnpm-workspace.yaml` is the marker because it exists exactly once per
 * checkout and travels with a worktree. `.git` does not qualify — in a
 * worktree it is a file, and a `../` count from the caller is the thing this
 * replaces: it changes when a test file moves, and a directory-walking guard
 * given the wrong tree still passes.
 */
export function findRepoRoot(startDir: string, marker: string = WORKSPACE_MARKER): string {
  for (let dir = startDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, marker))) return dir
    if (dirname(dir) === dir) {
      throw new Error(`no ${marker} in ${startDir} or any directory above it`)
    }
  }
}

let cached: string | undefined

/** The root of the checkout this module sits in, however deep the caller is. */
export function repoRoot(): string {
  cached ??= findRepoRoot(import.meta.dirname)
  return cached
}
