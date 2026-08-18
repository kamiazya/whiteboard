import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
 * Returns a new env object with WHITEBOARD_DATA_DIR pointed at
 * <repoRoot>/.dev-data, unless the caller already set it — an explicit
 * env override always wins over the repo-local dev default.
 *
 * Running from inside a git worktree resolves to that worktree's own
 * .dev-data, which is intentional: it keeps parallel dev-loop lanes from
 * sharing (and corrupting) one another's canvas data.
 */
// The project's own hosted-app origins (production + preview deployments).
// Dev-only default: the hosted app pairing with a local dev daemon is this
// repo's primary dogfood loop, and a hook-respawned daemon silently losing
// the allowance was a real dead end (2026-08-07). The published daemon keeps
// its loopback-only default — widening THAT is a product decision
// (see the default-allow-official-hosted-origins canvas).
const DEV_DEFAULT_ALLOWED_WEB_ORIGINS =
  'https://kamiazya-whiteboard.pages.dev,https://*.kamiazya-whiteboard.pages.dev'

/**
 * Returns a new env object with WHITEBOARD_ALLOWED_WEB_ORIGINS defaulted to
 * the project's own pages.dev origins. Any explicit caller value wins —
 * including the empty string, which deliberately restores loopback-only.
 */
export function resolveDevAllowedWebOriginsEnv(env) {
  if (env.WHITEBOARD_ALLOWED_WEB_ORIGINS !== undefined) {
    return { ...env }
  }
  return { ...env, WHITEBOARD_ALLOWED_WEB_ORIGINS: DEV_DEFAULT_ALLOWED_WEB_ORIGINS }
}

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

const PORT_FLAG_PREFIX = '--port='

/**
 * Finds the effective `--port=<value>` flag in argv, matching exactly what
 * `parseArg` in server/index.ts recognizes (first match wins). A bare,
 * space-separated `--port <value>` is NOT a recognized override — parseArg
 * only ever looks for the `--port=` prefix — so it must not be treated as
 * one here either, or injection and the server's actual listening port
 * disagree.
 *
 * @param {string[]} argv
 * @returns {number | undefined}
 */
function findPortFlagValue(argv) {
  const match = argv.find((arg) => arg.startsWith(PORT_FLAG_PREFIX))
  return match === undefined ? undefined : Number(match.slice(PORT_FLAG_PREFIX.length))
}

/**
 * Appends `--port=<derivedPort>` to argv unless the caller already passed
 * an explicit `--port=value`, which always wins. Returns a new array
 * (immutable).
 *
 * @param {string[]} argv
 * @param {number} derivedPort
 * @returns {string[]}
 */
export function injectDerivedPortArg(argv, derivedPort) {
  if (findPortFlagValue(argv) !== undefined) {
    return [...argv]
  }
  return [...argv, `${PORT_FLAG_PREFIX}${derivedPort}`]
}

/**
 * Resolves the port the spawned server will actually listen on, given the
 * argv passed to it after injectDerivedPortArg. Used to persist the true
 * effective port into the identity marker instead of always recording
 * derivedPort — a caller-provided `--port=value` override must be reflected
 * here too, or the marker disagrees with the real listening port and later
 * collision/identity checks make wrong decisions.
 *
 * @param {string[]} argvWithPort
 * @param {number} derivedPort
 * @returns {number}
 */
export function resolveEffectivePort(argvWithPort, derivedPort) {
  return findPortFlagValue(argvWithPort) ?? derivedPort
}

const DEV_DAEMON_MARKER_FILENAME = 'dev-daemon.json'

/**
 * Writes a small identity marker into the dev data dir recording which
 * worktree/port/pid started this daemon. ensure-http-dev-daemon reads this
 * back after a healthy probe to confirm the daemon answering on its derived
 * port actually belongs to this worktree, rather than being a foreign
 * daemon that happened to land on the same hashed port (or a stale process
 * from before per-worktree ports existed).
 *
 * Ensures `dataDir` exists first: resolveDataDir()'s contract only mkdir's
 * an explicit WHITEBOARD_DATA_DIR override lazily elsewhere (or not at all),
 * so a caller-provided override that hasn't been created yet would otherwise
 * make this throw ENOENT before the dev server is even spawned. This mkdir
 * is unconditional but permission-neutral — it never chmod's, so it does
 * not widen ensureDevDataDirSecured's hardening contract for the repo-local
 * default path.
 *
 * @param {string} dataDir
 * @param {{ port: number, repoRoot: string, pid: number }} args
 */
export function writeDevDaemonMarker(dataDir, { port, repoRoot, pid }) {
  mkdirSync(dataDir, { recursive: true })
  const marker = { port, repoRoot, pid, startedAt: new Date().toISOString() }
  writeFileSync(join(dataDir, DEV_DAEMON_MARKER_FILENAME), JSON.stringify(marker, null, 2))
}

/**
 * Reads the marker written by writeDevDaemonMarker. Returns null (never
 * throws) when the marker is absent or unparseable — both are treated as
 * "no trustworthy identity" by the caller, not as a crash.
 *
 * @param {string} dataDir
 * @returns {{ port: number, repoRoot: string, pid: number, startedAt: string } | null}
 */
export function readDevDaemonMarker(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, DEV_DAEMON_MARKER_FILENAME), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Best-effort removal of the identity marker on clean shutdown, so a
 * restarted daemon on a different port/pid doesn't leave a stale marker
 * behind that a probe could misread as still-valid.
 *
 * @param {string} dataDir
 */
export function removeDevDaemonMarker(dataDir) {
  try {
    rmSync(join(dataDir, DEV_DAEMON_MARKER_FILENAME))
  } catch {
    /* Absent marker (or unremovable) is fine — nothing to clean up. */
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
