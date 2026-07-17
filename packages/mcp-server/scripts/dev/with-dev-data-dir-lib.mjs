import { resolve } from 'node:path'

/**
 * Resolves the repo root from this script's own directory rather than the
 * process cwd — `pnpm -F @kamiazya/whiteboard-mcp mcp:http:dev` runs with
 * cwd=packages/mcp-server, so a cwd-relative guess would be wrong when
 * launched from the repo root (and wrong again from a worktree).
 *
 * dev -> scripts -> mcp-server -> packages -> repoRoot.
 */
export function resolveRepoRootFromScriptDir(scriptDir) {
  return resolve(scriptDir, '../../../..')
}

/**
 * Returns a new env object with WHITEBOARD_DATA_DIR pointed at
 * <repoRoot>/.dev-data, unless the caller already set it — an explicit
 * env override always wins over the repo-local dev default.
 *
 * Running from inside a git worktree resolves to that worktree's own
 * .dev-data, which is intentional: it keeps parallel dev-loop lanes from
 * sharing (and corrupting) one another's canvas data.
 */
export function resolveDevDataDirEnv(env, repoRoot) {
  if (env.WHITEBOARD_DATA_DIR) {
    return { ...env }
  }
  return { ...env, WHITEBOARD_DATA_DIR: resolve(repoRoot, '.dev-data') }
}
