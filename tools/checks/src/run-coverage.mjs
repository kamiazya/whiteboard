#!/usr/bin/env node

// @whiteboard/checks — run-coverage.
//
// CI entry point for the SonarQube lane's coverage run (sonarqube.yml). Runs
// every non-browser vitest project in ONE invocation so v8 writes a single
// merged lcov at tmp/coverage/lcov.info — Sonar accepts several report paths,
// but one run is also one install and one module graph.
//
// The project list is DERIVED from root vitest.config.ts (vitest-projects.mjs)
// for the same reason the shared-layer step derives its own: a new package is
// measured the moment it registers a project, with no edit here. Two classes
// are held out:
//   - browser projects, which need Playwright and a real Chrome, and whose v8
//     coverage would be charged to a page rather than to the module graph;
//   - mcp-smoke, which spawns the built stdio server and so needs a `pnpm
//     build` this job deliberately does not do.
//
// --testTimeout is widened for the run, and that is not slack: v8 instruments
// every module, so a test whose cost is the tree it walks or the cases a
// property generates gets MORE EXPENSIVE PER CASE and blows a budget it fits
// uninstrumented. Measured, two families did, in the shape that reads as a
// real defect and is not one: arch-lint's repo-coverage walk (19/19 files
// green without --coverage; 16.7s and a timeout with it) and loro-adapter's
// contentDigest properties (`Test timed out in 5000ms` printed WITH a seed,
// which looks exactly like a shrunk counterexample and is not — the property
// never failed, the runs did not fit). Holding those projects out was the
// first answer and the wrong one: it drops real product coverage to dodge a
// budget that is only tight because this lane made it so.
//
// Derives-and-execs rather than printing flags, for run-shared-layer-tests'
// reason: an empty --project filter set does not fail, it runs EVERY project.

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVitestArgv, readVitestProjects } from './vitest-projects.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(__dirname, '../../..')

// Keyed by CONFIG PATH, not project name, so renaming `test.name` cannot
// silently invalidate the exemption (PROJECTS_RUN_ELSEWHERE's convention).
const HELD_OUT = new Set(['packages/mcp-server/vitest.smoke.config.ts'])

// Six times the tightest per-test budget in the repo (5s). A hung test taking
// 30s instead of 5s to be declared hung costs a report-only lane nothing.
const INSTRUMENTED_TEST_TIMEOUT_MS = 30_000

/**
 * @param {string} repoRoot
 * @returns {string[]} sorted project names
 */
export function deriveCoverageProjectNames(repoRoot) {
  const names = readVitestProjects(repoRoot)
    .filter((p) => !p.isBrowser && !HELD_OUT.has(p.configPath))
    .map((p) => {
      if (!p.name) {
        throw new Error(`${p.configPath} would be measured for coverage but declares no test.name`)
      }
      return p.name
    })
  if (names.length === 0) {
    throw new Error(
      'deriveCoverageProjectNames found no projects — refusing to spawn vitest with an empty --project filter, which would run every project (including browser ones) with no Playwright installed',
    )
  }
  return names.sort()
}

/**
 * @param {{ repoRoot?: string, stderr?: { write: (chunk: string) => boolean }, spawn?: typeof spawnSync }} [options]
 * @returns {number} process exit code
 */
export function main(options = {}) {
  const { repoRoot = DEFAULT_REPO_ROOT, stderr = process.stderr, spawn = spawnSync } = options

  let names
  try {
    names = deriveCoverageProjectNames(repoRoot)
  } catch (err) {
    stderr.write(
      `[run-coverage] derivation failed, refusing to run vitest with no project filter: ${/** @type {Error} */ (err).message}\n`,
    )
    return 1
  }

  stderr.write(`[run-coverage] derived ${names.length} project(s): ${names.join(', ')}\n`)

  const result = spawn(
    'pnpm',
    [...buildVitestArgv(names), '--coverage', `--testTimeout=${INSTRUMENTED_TEST_TIMEOUT_MS}`],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  )
  if (result.error) {
    stderr.write(`[run-coverage] pnpm could not start: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
