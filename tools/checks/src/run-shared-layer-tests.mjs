#!/usr/bin/env node

// @whiteboard/checks — run-shared-layer-tests.
//
// CI entry point for the "Test shared-layer packages + arch-lint" step
// (ci.yml, test-unit job, shard 2). Derives the project list from root
// vitest.config.ts (see vitest-projects.mjs) instead of a hand-listed set of
// `--project=` flags, so a new shared-layer package is picked up by CI the
// moment it registers a node-mode project, with no ci.yml edit.
//
// Derives-and-execs rather than printing flags for a shell command
// substitution to consume: a derivation that throws or returns empty must
// never degrade to "no --project filter at all", which would run every
// project — including the three browser ones — in a job with no Playwright
// installed. Spawning here, after the derivation succeeded and was checked
// non-empty, is what makes that outcome unreachable rather than merely
// unlikely.

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVitestArgv, deriveSharedLayerProjectNames } from './vitest-projects.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(__dirname, '../../..')

/**
 * @typedef {{
 *   repoRoot?: string,
 *   stdout?: { write: (chunk: string) => boolean },
 *   stderr?: { write: (chunk: string) => boolean },
 *   spawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null, error?: Error },
 * }} MainOptions
 */

/**
 * @param {MainOptions} [options]
 * @returns {number} process exit code
 */
export function main(options = {}) {
  const {
    repoRoot = DEFAULT_REPO_ROOT,
    stdout = process.stdout,
    stderr = process.stderr,
    spawn = spawnSync,
  } = options

  let names
  try {
    names = deriveSharedLayerProjectNames(repoRoot)
  } catch (err) {
    stderr.write(
      `[run-shared-layer-tests] derivation failed, refusing to run vitest with no project filter: ${/** @type {Error} */ (err).message}\n`,
    )
    return 1
  }

  stderr.write(`[run-shared-layer-tests] derived ${names.length} project(s): ${names.join(', ')}\n`)

  const argv = buildVitestArgv(names)
  const result = spawn('pnpm', argv, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) {
    stderr.write(`[run-shared-layer-tests] pnpm could not start: ${result.error.message}\n`)
    return 1
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) {
    stdout.write(`[run-shared-layer-tests] OK: ${names.length} project(s) passed\n`)
  }
  return exitCode
}

// Direct-run guard: execute only when this file is the CLI entry point,
// never when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
