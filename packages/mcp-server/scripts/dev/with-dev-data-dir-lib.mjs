import { execFileSync } from 'node:child_process'
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
 * Resolves the repo root via `git rev-parse --show-toplevel`, which always
 * returns the correct worktree root when called from inside one. This is
 * the only reliable method because pnpm resolves dev scripts through
 * symlinked node_modules back to the main checkout, making import.meta.url-
 * based resolution wrong for worktrees.
 *
 * @param {string} cwd - The working directory to resolve from.
 * @returns {string}
 */
export function resolveRepoRootFromGit(cwd) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
}

/**
 * The checkout a Claude Code hook is about. The hook inherits the session's
 * working directory, which may be a package directory — or, for a session
 * started elsewhere, not this repository at all — while `CLAUDE_PROJECT_DIR`
 * always names the project the session was opened on. Either is resolved
 * through git, so a subdirectory answers with its checkout (worktree) root.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @returns {string}
 */
export function resolveHookProjectRoot(env, cwd) {
  const projectDir = env.CLAUDE_PROJECT_DIR
  return resolveRepoRootFromGit(projectDir ? projectDir : cwd)
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
 *
 * `kill` and `exit` are typed by what this function does with them (call, and
 * ignore the answer), so a test can inject a recorder rather than something
 * that really never returns.
 * @param {string} signal
 * @param {{ pid?: number, kill?: (pid: number, signal?: string | number) => unknown, exit?: (code?: number) => unknown }} [seams]
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
 * The stop signals a terminal, a supervisor or `kill` send. Anything that
 * stops the wrapper has to stop what it runs: `pnpm`/`sh` do not relay a
 * signal sent to one process of the chain, so a wrapper that dies alone leaves
 * `tsx watch` and the daemon it spawned alive on the socket.
 */
export const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP']

/**
 * Where the wrapper records its own pid while it runs. `daemon.json` names the
 * daemon, two process levels below the wrapper; stopping the daemon alone
 * leaves `tsx watch` and the wrapper alive to restart it, so a stop has to
 * reach the wrapper.
 *
 * @param {string} dataDir
 */
export function devWrapperPidPath(dataDir) {
  return resolve(dataDir, 'dev-wrapper.pid')
}

/**
 * Ties the wrapper's lifetime to its child's: forwards the stop signals to it
 * and ends the wrapper only when the child has. The forwarding listeners are
 * removed before the wrapper re-raises the child's own signal, because a live
 * SIGTERM listener would swallow that re-raise and the wrapper would never
 * exit.
 *
 * @param {import('node:events').EventEmitter & { kill: (signal?: string) => unknown }} child
 * @param {{
 *   proc?: Pick<NodeJS.Process, 'on' | 'removeListener'>,
 *   exit?: (code?: number) => unknown,
 *   reraise?: (signal: string) => unknown,
 *   write?: (text: string) => unknown,
 *   cleanup?: () => unknown,
 *   signals?: readonly string[],
 * }} [seams]
 */
export function superviseChild(
  child,
  {
    proc = process,
    exit = process.exit,
    reraise = reraiseSignalOrExit,
    write = (text) => process.stderr.write(text),
    cleanup = () => {},
    signals = FORWARDED_SIGNALS,
  } = {},
) {
  const forwarders = signals.map((signal) => {
    const forward = () => {
      child.kill(signal)
    }
    proc.on(signal, forward)
    return { signal, forward }
  })
  const release = () => {
    for (const { signal, forward } of forwarders) proc.removeListener(signal, forward)
    cleanup()
  }

  child.on('error', (error) => {
    release()
    write(`[with-dev-data-dir] failed to spawn dev server: ${error.message}\n`)
    exit(1)
  })
  child.on('exit', (code, signal) => {
    release()
    if (signal) {
      reraise(signal)
      return
    }
    exit(code ?? 1)
  })
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
