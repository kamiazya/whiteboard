// `pnpm deploy --legacy --prod` writes its prod-only settings into the
// WORKSPACE's install-state file, so the next top-level pnpm command would
// reinstall without devDependencies (or abort without a TTY); this puts the
// file back as it was.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORKSPACE_STATE_FILE = '.pnpm-workspace-state-v1.json'

/**
 * The `pnpm` arguments that deploy `filter`'s production dependencies into
 * `target`.
 *
 * --legacy: the workspace does not set `inject-workspace-packages`, which a
 *   non-legacy deploy requires.
 * --ignore-scripts: no lifecycle scripts are needed to read the dependency graph.
 *
 * @param {string} filter
 * @param {string} target
 * @returns {string[]}
 */
function deployArgs(filter, target) {
  return ['--filter', filter, 'deploy', '--legacy', '--prod', '--ignore-scripts', target]
}

/**
 * Deploys `filter`'s production dependencies into `target` from
 * `workspaceRoot`. The one launcher, so the real-pnpm test exercises the
 * spawn the SBOM script makes, options included, and not only its flags.
 * Output is captured, never relayed. No shell: Windows contributors work in
 * WSL2 (docs/contributing/development.md), where pnpm is a plain executable.
 *
 * @param {string} workspaceRoot
 * @param {string} filter
 * @param {string} target
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function runDeploy(workspaceRoot, filter, target) {
  return spawnSync('pnpm', deployArgs(filter, target), {
    encoding: 'utf-8',
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

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
