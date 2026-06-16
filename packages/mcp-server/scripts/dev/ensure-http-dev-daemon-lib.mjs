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
