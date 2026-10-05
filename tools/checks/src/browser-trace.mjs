#!/usr/bin/env node

// @whiteboard/checks — browser-trace, the `pnpm test:browser:trace` script.
//
// Runs the real-browser projects with a Playwright trace for EVERY test and
// its DOM snapshots, for the one failing file it is pointed at. A DOM snapshot
// records every resource vite served so the viewer can replay the page, and
// that is what makes the trace expensive: 302MB against 7.5MB on `apps/web`'s
// 16 page files, and 22-23GB over a whole run, which filled this container's
// disk mid-run and reported it as `Failed to fetch dynamically imported
// module` with a short test count rather than as "no space". So a run with no
// file filter is refused here, before vitest starts, instead of being a
// warning in the docs a script invocation never reads.
//
// The project list is read from the root vitest.config.ts inventory, the
// same one `test:browser` is checked against, so a browser project added
// there is traced here without an edit.

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRunAsScript } from './is-run-as-script.mjs'
import { readBrowserProjectNames } from './vitest-projects.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(__dirname, '../../..')

/**
 * Vitest options that take their value as the NEXT argument. That value is
 * not a file filter, so `-t saves` or `--project web-browser` alone still
 * names no file and still runs a whole suite.
 */
const VALUE_OPTIONS = new Set([
  '-t',
  '--testNamePattern',
  '--project',
  '--reporter',
  '--outputFile',
  '--shard',
  '-c',
  '--config',
  '-r',
  '--root',
  '--dir',
  '--exclude',
])

export const USAGE = [
  '[browser-trace] refusing a trace run with no file filter.',
  'It records a Playwright trace with DOM snapshots for EVERY test it runs: about 22GB over',
  'the whole browser suite, enough to fill the disk mid-run. Point it at the one failing file:',
  '',
  '  pnpm test:browser:trace <path/to/failing.browser.test.tsx>',
  '',
].join('\n')

/**
 * The positional arguments vitest reads as file filters: anything that is not
 * an option and not the value of one in `VALUE_OPTIONS`. A leading `--`, which
 * some runners pass through, is neither.
 *
 * @param {readonly string[]} args
 * @returns {string[]}
 */
export function fileFilters(args) {
  const filters = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg.startsWith('-')) {
      if (VALUE_OPTIONS.has(arg)) i += 1
      continue
    }
    filters.push(arg)
  }
  return filters
}

/**
 * @typedef {{
 *   argv?: readonly string[],
 *   repoRoot?: string,
 *   env?: NodeJS.ProcessEnv,
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
    argv = process.argv.slice(2),
    repoRoot = DEFAULT_REPO_ROOT,
    env = process.env,
    stderr = process.stderr,
    spawn = spawnSync,
  } = options

  const args = argv.filter((arg) => arg !== '--')
  if (fileFilters(args).length === 0) {
    stderr.write(USAGE)
    return 2
  }

  const projects = readBrowserProjectNames(repoRoot).map((name) => `--project=${name}`)
  const result = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', ...projects, '--browser.trace=on', ...args],
    { stdio: 'inherit', env: { ...env, WHITEBOARD_TRACE_SNAPSHOTS: '1' } },
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
