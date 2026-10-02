import { execFileSync } from 'node:child_process'

/**
 * The files git tracks under `root` matching `pathspecs` (git's own globs, so
 * `*.md` matches at any depth).
 *
 * Tracked rather than walked: a walk also reads `node_modules`, build output
 * and the ephemeral `.claude/worktrees/*` checkouts of this same tree, so one
 * stale line would be reported once per checkout.
 */
export function trackedFiles(root: string, ...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', ...pathspecs], { cwd: root, encoding: 'utf-8' })
    .split('\n')
    .filter((file) => file !== '')
}
