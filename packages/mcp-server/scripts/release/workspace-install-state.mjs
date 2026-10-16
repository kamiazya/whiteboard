// `pnpm deploy --legacy --prod` writes its prod-only settings into the
// WORKSPACE's install-state file, so the next top-level pnpm command would
// reinstall without devDependencies (or abort without a TTY); this puts the
// file back as it was.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORKSPACE_STATE_FILE = '.pnpm-workspace-state-v1.json'

/**
 * Runs `step`, then restores `<workspaceRoot>/node_modules/<WORKSPACE_STATE_FILE>`
 * to its prior bytes — or removes it if it did not exist — whether `step`
 * returned or threw.
 *
 * @template T
 * @param {string} workspaceRoot
 * @param {() => T} step
 * @returns {T}
 */
export function preservingWorkspaceInstallState(workspaceRoot, step) {
  const statePath = join(workspaceRoot, 'node_modules', WORKSPACE_STATE_FILE)
  const before = existsSync(statePath) ? readFileSync(statePath) : undefined
  try {
    return step()
  } finally {
    if (before === undefined) rmSync(statePath, { force: true })
    else writeFileSync(statePath, before)
  }
}
