import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * A linked git worktree has a `.git` FILE (`gitdir: <path>`); the main
 * checkout has a `.git` DIRECTORY.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isMainCheckout(repoRoot) {
  const gitPath = join(resolve(repoRoot), '.git')
  let stats
  try {
    stats = lstatSync(gitPath)
  } catch {
    // No .git at all (npm tarball extraction, some sandboxed checkouts) is
    // not a linked worktree — answer "main checkout" rather than crashing
    // dev tooling over a checkout-type check that has no bearing on whether
    // the server itself can run.
    return true
  }
  return stats.isDirectory()
}
