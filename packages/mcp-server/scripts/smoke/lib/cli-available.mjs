// Shared guard for the LLM-CLI smokes (mcp-claude-cli-smoke.mjs,
// mcp-codex-cli-smoke.mjs). Those smokes spawn a real `claude` / `codex`
// binary and burn API quota, so CI images intentionally ship without either
// CLI installed. Without this guard the smokes fail with `spawn ... ENOENT`
// on every CI runner instead of skipping cleanly.

import { spawnSync } from 'node:child_process'

/**
 * @param {string} command
 * @param {(cmd: string, args: string[], opts: import('node:child_process').SpawnSyncOptions) => import('node:child_process').SpawnSyncReturns<Buffer>} spawnSyncImpl
 * @returns {boolean}
 */
export function isCliAvailable(command, spawnSyncImpl = spawnSync) {
  // Windows installs npm-global CLIs as .cmd/.bat shims, which execvp cannot
  // launch directly — they need a shell to resolve. shell:true is safe here
  // because `command` is always one of our own fixed literals ('claude',
  // 'codex'), never attacker- or user-controlled input.
  const result = spawnSyncImpl(command, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  if (result.error) {
    return false
  }
  return typeof result.status === 'number' && result.status === 0
}
