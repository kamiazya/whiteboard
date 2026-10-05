#!/usr/bin/env node

// @whiteboard/checks — browser-trace, the `pnpm test:browser:trace` script.
//
// Runs the real-browser projects with a Playwright trace for EVERY test and
// its DOM snapshots, for the one failing file it is pointed at. A DOM snapshot
// records every resource vite served so the viewer can replay the page, and
// that is what makes the trace expensive: 302MB against 7.5MB on `apps/web`'s
// 16 page files, and 22-23GB over a whole run, which filled this container's
// disk mid-run and reported it as `Failed to fetch dynamically imported
// module` with a short test count rather than as "no space". So a run that
// selects more than a few files is refused here, before it starts, instead of
// being a warning in the docs a script invocation never reads.
//
// What the arguments select is vitest's answer, not this script's: it is asked
// with `vitest list --filesOnly` over the same projects and arguments the run
// gets. A hand-kept table of which options take a value cannot keep up with
// vitest's (missing `--testTimeout` read `--testTimeout 60000` as a file
// filter named `60000` and let the whole suite through), and no table can say
// how much a directory filter selects. The ask
// costs one config load of the browser projects, about 9s of CPU and 11-28s
// wall at a load average of 15-25 on four cores — against a one-file trace
// run that took 29s inside vitest on top of its own config load.
//
// The project list is read from the root vitest.config.ts inventory, the
// same one `test:browser` is checked against, so a browser project added
// there is traced here without an edit.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRunAsScript } from './is-run-as-script.mjs'
import { readBrowserProjectNames } from './vitest-projects.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(__dirname, '../../..')

/**
 * The most test files one trace run may select. `apps/web`'s 16 page files
 * traced to 302MB, so this many stays well under a gigabyte, while the whole
 * browser suite is a few hundred files and 22GB.
 */
export const MAX_TRACED_FILES = 10

/** @param {number} count */
function refusal(count) {
  return [
    `[browser-trace] refusing a trace run that selects ${count} test files (at most ${MAX_TRACED_FILES}).`,
    'It records a Playwright trace with DOM snapshots for EVERY test it runs: about 22GB over',
    'the whole browser suite, enough to fill the disk mid-run. Point it at the one failing file:',
    '',
    '  pnpm test:browser:trace <path/to/failing.browser.test.tsx>',
    '',
  ].join('\n')
}

/**
 * @typedef {(cmd: string, args: string[], opts: Record<string, unknown>) =>
 *   { status: number | null, error?: Error, stderr?: string | Buffer | null }} Spawn
 */

/**
 * How many test files vitest would run for these projects and arguments, or
 * the reason it could not say. The answer goes to a file rather than stdout,
 * so nothing a config prints while loading can be mistaken for it.
 *
 * @param {{ spawn: Spawn, projects: string[], args: string[], cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {{ count: number } | { error: string }}
 */
function selectedFileCount({ spawn, projects, args, cwd, env }) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-trace-list-'))
  const out = join(dir, 'files.json')
  try {
    const result = spawn(
      'pnpm',
      ['exec', 'vitest', 'list', '--filesOnly', `--json=${out}`, ...projects, ...args],
      { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    )
    if (result.error) return { error: `pnpm could not start: ${result.error.message}` }
    if (result.status !== 0) {
      return { error: `vitest list exited ${result.status}\n${result.stderr ?? ''}` }
    }
    const files = JSON.parse(readFileSync(out, 'utf8'))
    if (!Array.isArray(files)) return { error: `vitest list wrote no file array to ${out}` }
    return { count: files.length }
  } catch (err) {
    return { error: `could not read what vitest list selected: ${String(err)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * @typedef {{
 *   argv?: readonly string[],
 *   repoRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stderr?: { write: (chunk: string) => boolean },
 *   spawn?: Spawn,
 * }} MainOptions
 */

/**
 * @param {MainOptions} [options]
 * @returns {number} process exit code
 */
export function main(options = {}) {
  const {
    argv = process.argv.slice(2),
    repoRoot = DEFAULT_REPO_ROOT,
    env = process.env,
    stderr = process.stderr,
    spawn = /** @type {Spawn} */ (/** @type {unknown} */ (spawnSync)),
  } = options

  const args = argv.filter((arg) => arg !== '--')
  const projects = readBrowserProjectNames(repoRoot).map((name) => `--project=${name}`)

  // Fails closed: a selection nobody could count is refused like a large one.
  const selected = selectedFileCount({ spawn, projects, args, cwd: repoRoot, env })
  if ('error' in selected) {
    stderr.write(`[browser-trace] refusing: ${selected.error}\n`)
    return 2
  }
  if (selected.count > MAX_TRACED_FILES) {
    stderr.write(refusal(selected.count))
    return 2
  }

  const result = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', ...projects, '--browser.trace=on', ...args],
    { cwd: repoRoot, stdio: 'inherit', env: { ...env, WHITEBOARD_TRACE_SNAPSHOTS: '1' } },
  )
  if (result.error) {
    stderr.write(`[browser-trace] pnpm could not start: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

if (isRunAsScript(import.meta.url)) {
  process.exit(main())
}
