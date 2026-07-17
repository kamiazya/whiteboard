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
 * A daemon that never wrote a marker for this data dir, or whose marker
 * names a different port, is "foreign" — it may be a hash-collision daemon
 * from another worktree sharing the default bearer token, or a stale
 * pre-port-split daemon. A marker whose recorded pid is no longer running
 * is "stale" (its process died without cleaning up); a marker whose port
 * matches and whose pid is alive is "ours".
 *
 * @param {{ marker: { port: number, pid: number } | null, expectedPort: number, isPidAlive: (pid: number) => boolean }} args
 * @returns {'ours' | 'stale' | 'foreign'}
 */
export function verifyDevDaemonIdentity({ marker, expectedPort, isPidAlive }) {
  if (!marker || marker.port !== expectedPort) {
    return 'foreign'
  }
  return isPidAlive(marker.pid) ? 'ours' : 'stale'
}
