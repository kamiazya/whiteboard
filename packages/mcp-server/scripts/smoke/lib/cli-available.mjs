// Shared guard for the LLM-CLI smokes (mcp-claude-cli-smoke.mjs,
// mcp-codex-cli-smoke.mjs). Those smokes spawn a real `claude` / `codex`
// binary and burn API quota, so CI images intentionally ship without either
// CLI installed. Without this guard the smokes fail with `spawn ... ENOENT`
// on every CI runner instead of skipping cleanly.

/**
 * @param {string} command
 * @param {(cmd: string, args: string[], opts: import('node:child_process').SpawnSyncOptions) => import('node:child_process').SpawnSyncReturns<Buffer>} spawnSyncImpl
 * @returns {boolean}
 */
export function isCliAvailable(command, spawnSyncImpl) {
  const result = spawnSyncImpl(command, ['--version'], { stdio: 'ignore' })
  if (result.error) {
    return false
  }
  return typeof result.status === 'number' && result.status === 0
}
