#!/usr/bin/env node
// @whiteboard/checks — pages-release runner.
//
// Executor for the `pages-release` tier of tests/e2e/distribution/release-gate-matrix.json.
// The matrix is the single policy source: this runner reads the pages-release gates from
// it and runs them in order, after a `pnpm build` prerequisite. Adding or changing a Pages
// gate is done in the matrix, not here.
//
// The core (planSteps / runSteps) is exported and spawn-injectable so the ordering and
// fail-fast behavior can be unit-tested without a real build. main() runs only when the
// file is executed directly (the direct-run guard below), so importing it is side-effect free.
//
// smoke:preview-origin needs Playwright and a local 127.0.0.1 HTTP bind; it fails with
// EPERM in a network-restricted sandbox and runs green in a normal environment.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateMatrix } from './release-gate-matrix-schema.mjs'
import { splitCommand } from './split-command.mjs'

export const USAGE = `Usage: pnpm --filter @whiteboard/checks pages-release

Runs the Cloudflare Pages release gates (the "pages-release" tier of
tests/e2e/distribution/release-gate-matrix.json), from the repo root, in order:
  1. pnpm build
  2. each pages-release gate command, fail-fast on the first non-zero exit

Options:
  -h, --help   Show this help and exit.

Note: smoke:preview-origin needs Playwright and a local 127.0.0.1 HTTP bind
(it fails with EPERM in a network-restricted sandbox).
`

// Build the ordered step list: a `pnpm build` prerequisite followed by each
// pages-release gate from the matrix, in matrix order. build comes first because
// the artifact gates read apps/web/dist/.
export function planSteps(gates) {
  const pagesGates = gates.filter((gate) => gate.requiredFor.includes('pages-release'))
  return [
    { label: 'build', command: 'pnpm build' },
    ...pagesGates.map((gate) => ({ label: gate.id, command: gate.command })),
  ]
}

// Run steps in order, fail-fast on the first non-zero exit. `spawn` is injectable
// (defaults to spawnSync) so tests can assert ordering / fail-fast without real processes.
// Returns { ok, exitCode, ranLabels } instead of calling process.exit, so it stays testable.
export function runSteps(steps, options = {}) {
  const { cwd, spawn = spawnSync, stdout = process.stdout, stderr = process.stderr } = options
  const ranLabels = []
  for (let i = 0; i < steps.length; i++) {
    const { label, command } = steps[i]
    stdout.write(`\n[pages-release] step ${i + 1}/${steps.length}: ${label}\n  $ ${command}\n`)
    let argv
    try {
      argv = splitCommand(command)
    } catch (err) {
      stderr.write(`[pages-release] invalid gate command for "${label}": ${err.message}\n`)
      return { ok: false, exitCode: 1, ranLabels }
    }
    const [cmd, ...args] = argv
    ranLabels.push(label)
    const result = spawn(cmd, args, { cwd, stdio: 'inherit' })
    if (result.error) {
      stderr.write(`[pages-release] step "${label}" could not start: ${result.error.message}\n`)
      return { ok: false, exitCode: 1, ranLabels }
    }
    if (result.status !== 0) {
      stderr.write(`[pages-release] step "${label}" failed (exit ${result.status})\n`)
      return { ok: false, exitCode: result.status ?? 1, ranLabels }
    }
  }
  stdout.write('\n[pages-release] all steps passed\n')
  return { ok: true, exitCode: 0, ranLabels }
}

// Classify CLI args. A release gate runner must not run its gates on a typo'd flag,
// so only a no-argument invocation runs; -h/--help prints usage; anything else errors.
export function parseArgs(args) {
  if (args.includes('-h') || args.includes('--help')) return { mode: 'help' }
  if (args.length > 0)
    return { mode: 'error', message: `unexpected argument(s): ${args.join(' ')}` }
  return { mode: 'run' }
}

// Testable core of the CLI entry point: every I/O boundary (argv, matrix
// read, spawn, stdout/stderr) is injectable, matching publish-gate.mjs's
// main() so both matrix-driven runners share the same fail-loud invalid-
// matrix behavior and the same test shape. Returns an exit code instead of
// calling process.exit, so it stays testable.
/**
 * @param {{
 *   argv?: string[],
 *   repoRoot?: string,
 *   readMatrix?: (matrixPath: string) => unknown,
 *   spawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null, error?: Error },
 *   stdout?: { write: (chunk: string) => boolean },
 *   stderr?: { write: (chunk: string) => boolean },
 * }} [options]
 * @returns {number} process exit code
 */
export function main(options = {}) {
  const {
    argv = process.argv.slice(2),
    repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    readMatrix = (matrixPath) => JSON.parse(readFileSync(matrixPath, 'utf-8')),
    spawn = spawnSync,
    stdout = process.stdout,
    stderr = process.stderr,
  } = options

  const parsed = parseArgs(argv)
  if (parsed.mode === 'help') {
    stdout.write(USAGE)
    return 0
  }
  if (parsed.mode === 'error') {
    stderr.write(`[pages-release] ${parsed.message}\n\n`)
    stderr.write(USAGE)
    return 1
  }
  const matrixPath = resolve(repoRoot, 'tests/e2e/distribution/release-gate-matrix.json')
  const matrix = readMatrix(matrixPath)
  // Fail loud on a structurally invalid matrix instead of silently running a
  // gate subset that drifted from the policy the matrix is supposed to encode.
  const validation = validateMatrix(matrix)
  if (!validation.ok) {
    stderr.write(`[pages-release] invalid release-gate-matrix.json: ${validation.reason}\n`)
    return 1
  }
  const steps = planSteps(matrix.gates)
  // steps always contains the build prerequisite; <= 1 means no pages-release gates.
  if (steps.length <= 1) {
    stderr.write('[pages-release] no pages-release gates found in release-gate-matrix.json\n')
    return 1
  }
  const { exitCode } = runSteps(steps, { cwd: repoRoot, spawn, stdout, stderr })
  return exitCode
}

// Direct-run guard: execute the gates only when this file is the CLI entry point,
// never when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
