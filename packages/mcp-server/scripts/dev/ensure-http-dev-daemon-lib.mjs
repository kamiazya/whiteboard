// Upper bound on how long ensure-http-dev-daemon.mjs waits for a spawned
// daemon to answer. tsx + happy-dom + canvas + resvg cold start + node_modules
// linking can take ~10-15s on slow machines, so leave generous headroom —
// the hook only runs once per session start, so this isn't on a hot path.
export const DEFAULT_READY_TIMEOUT_MS = 30_000

/**
 * Resolves the ready-wait bound from WHITEBOARD_DEV_READY_TIMEOUT_MS,
 * falling back to DEFAULT_READY_TIMEOUT_MS whenever the override is absent
 * or malformed (non-numeric, non-integer, zero, or negative). Total and
 * never throws — a SessionStart hook must not die over a stray dev env var,
 * it should just behave as if the override were never set. Kept as a
 * seam mainly so tests can exercise the timeout path in well under 30s.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function resolveReadyTimeoutMs(env) {
  const raw = env.WHITEBOARD_DEV_READY_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_READY_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_READY_TIMEOUT_MS
  return parsed
}

export async function waitForAuthenticatedMcp({
  probe,
  sleep,
  timeoutMs,
  pollIntervalMs,
  now = Date.now,
}) {
  const startedAt = now()
  while (now() - startedAt < timeoutMs) {
    if ((await probe()) === 'ours') return true
    await sleep(pollIntervalMs)
  }
  return false
}

const PACKAGE_SCRIPT_DEFAULT_TOKEN = 'whiteboard-dev'

/**
 * Resolves the dev bearer token from env, falling back to the value that
 * `pnpm mcp:http:dev` bakes in via `--token=whiteboard-dev`. Extracted as
 * a pure function so the resolution logic is testable without module reload.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveDevBearerToken(env) {
  return env.WHITEBOARD_TOKEN ?? PACKAGE_SCRIPT_DEFAULT_TOKEN
}

/**
 * Builds the pnpm argument list for spawning `pnpm mcp:http:dev`.
 * Appends `--token=<value>` only when the token differs from the value
 * already baked into the package script (`--token=whiteboard-dev`), so
 * a custom WHITEBOARD_TOKEN is honoured without duplicating the flag on
 * the default path. Always appends `--port=<derivedPort>` — the package
 * script itself no longer bakes in a port, so this is the one place the
 * spawned daemon's port comes from.
 *
 * @param {string} token
 * @param {number} derivedPort
 * @returns {string[]}
 */
export function buildMcpHttpDevSpawnArgs(token, derivedPort) {
  const base = ['mcp:http:dev']
  if (token !== PACKAGE_SCRIPT_DEFAULT_TOKEN) {
    base.push(`--token=${token}`)
  }
  base.push(`--port=${derivedPort}`)
  return base
}

/**
 * Decides whether a daemon that answered an authenticated MCP probe on this
 * worktree's derived port actually belongs to this worktree.
 *
 * A missing marker is "no-marker", not "foreign" — it is indistinguishable
 * from a daemon started before this feature existed (or before it wrote its
 * first marker), which is overwhelmingly the common case on a first-adopt
 * run. Treating that the same as an actual identity mismatch would hard-fail
 * with no self-healing path. A marker whose port or repoRoot disagrees with
 * what's expected is "foreign" — either a hash-collision daemon from a
 * different worktree sharing the default bearer token, or a stale
 * pre-port-split daemon. The repoRoot check (not just port) is what catches
 * a startup race between two worktrees that both observed the same derived
 * port free and raced to bind it — port equality alone can't tell those
 * apart. A marker whose port and repoRoot both match, but whose recorded pid
 * is no longer running, is "stale"; matching port, repoRoot, and a live pid
 * is "ours".
 *
 * @param {{ marker: { port: number, repoRoot: string, pid: number } | null, expectedPort: number, expectedRepoRoot: string, isPidAlive: (pid: number) => boolean }} args
 * @returns {'ours' | 'stale' | 'foreign' | 'no-marker'}
 */
export function verifyDevDaemonIdentity({ marker, expectedPort, expectedRepoRoot, isPidAlive }) {
  if (!marker) {
    return 'no-marker'
  }
  if (marker.port !== expectedPort || marker.repoRoot !== expectedRepoRoot) {
    return 'foreign'
  }
  return isPidAlive(marker.pid) ? 'ours' : 'stale'
}

/**
 * Decides whether a verifyDevDaemonIdentity() verdict should let the caller
 * self-heal (assume the daemon on the port is this worktree's own) instead
 * of hard-failing.
 *
 * "stale" means the marker's port and repoRoot both matched this worktree —
 * only the recorded pid is dead. The marker's pid is the with-dev-data-dir
 * wrapper's own pid, written before it spawns the actual server as a child
 * and removed on that child's normal exit; a dead wrapper pid with the port
 * still answering MCP means the wrapper died abnormally (crash, SIGKILL, a
 * platform-specific pid-liveness quirk) while its child kept running and
 * bound. That is this worktree's own daemon, not a different worktree's
 * hash-collision (which "foreign" already catches via port/repoRoot
 * mismatch) — so treat it the same as "no-marker" rather than hard-failing.
 *
 * @param {'ours' | 'stale' | 'foreign' | 'no-marker'} identity
 * @returns {boolean}
 */
export function isSelfHealableIdentity(identity) {
  return identity === 'no-marker' || identity === 'stale'
}
