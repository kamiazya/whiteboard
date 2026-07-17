import { chmodSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Owner-only, matching shared/data-dir-secure.ts's POSIX_DATA_DIR_MODE. Kept
// as a separate literal here (rather than importing the TS module) because
// these dev scripts run directly via `node`, before any build step.
const DEV_DATA_DIR_MODE = 0o700

/**
 * Creates (if missing) and hardens the dev data dir to owner-only
 * permissions. resolveDataDir() in shared/data-dir-secure.ts only applies
 * this hardening on its own home-directory default path — an explicit
 * WHITEBOARD_DATA_DIR (which is exactly what this wrapper sets) short-circuits
 * that check and returns immediately. Without this, `.dev-data` can end up
 * created at 0755 under a common umask, leaving the SQLite DB and daemon
 * token world/group-readable on shared machines.
 */
export function ensureDevDataDirSecured(dir, platformName = process.platform) {
  mkdirSync(dir, { recursive: true, mode: DEV_DATA_DIR_MODE })
  if (platformName !== 'win32') {
    try {
      // mkdir's mode can still be widened by umask, so tighten it again.
      chmodSync(dir, DEV_DATA_DIR_MODE)
    } catch {
      /* Best-effort only; dev startup should continue even if this fails. */
    }
  }
}

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

/**
 * Re-raises a signal the child process died from so the parent's own exit
 * reflects it (matching shell semantics for a wrapped command). `kill(pid,
 * signal)` with a POSIX signal name can throw EINVAL on Windows — Windows
 * has no POSIX signal delivery, so falling through uncaught would crash this
 * wrapper instead of just exiting non-zero.
 */
export function reraiseSignalOrExit(
  signal,
  { pid = process.pid, kill = process.kill, exit = process.exit } = {},
) {
  try {
    kill(pid, signal)
  } catch {
    exit(1)
  }
}

/**
 * Resolves the command + args to launch `tsx watch <entry>` cross-platform.
 *
 * `node_modules/.bin/tsx` is a POSIX shell shim (paired with `.cmd`/`.ps1`
 * wrappers on Windows); spawning it directly with `shell: false` only works
 * on POSIX. tsx's package.json `bin` field points at a plain ESM entrypoint
 * (`dist/cli.mjs`), so spawning `node <that file>` sidesteps the platform
 * shim entirely and behaves identically on every OS.
 */
export function resolveTsxWatchSpawn(
  packageRoot,
  entryPath,
  extraArgs,
  { execPath = process.execPath } = {},
) {
  const tsxCliPath = resolve(packageRoot, 'node_modules/tsx/dist/cli.mjs')
  return {
    command: execPath,
    args: [tsxCliPath, 'watch', entryPath, ...extraArgs],
  }
}
