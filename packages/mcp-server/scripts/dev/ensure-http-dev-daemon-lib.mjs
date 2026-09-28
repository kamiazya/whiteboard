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
  // Number(undefined) is NaN and Number('') is 0, so an absent or empty
  // override falls through the same guard as a malformed one.
  const parsed = Number(env.WHITEBOARD_DEV_READY_TIMEOUT_MS)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_READY_TIMEOUT_MS
  return parsed
}

/** Polls `isUp` until it answers true, or the timeout elapses. */
export async function waitForDaemon({ isUp, sleep, timeoutMs, pollIntervalMs, now = Date.now }) {
  const startedAt = now()
  while (now() - startedAt < timeoutMs) {
    if (await isUp()) return true
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
 * the default path.
 *
 * @param {string} token
 * @returns {string[]}
 */
export function buildMcpHttpDevSpawnArgs(token) {
  const base = ['mcp:http:dev']
  if (token !== PACKAGE_SCRIPT_DEFAULT_TOKEN) {
    base.push(`--token=${token}`)
  }
  return base
}
