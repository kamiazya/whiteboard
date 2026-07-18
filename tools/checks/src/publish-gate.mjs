#!/usr/bin/env node
// @whiteboard/checks — publish-gate runner.
//
// Executor for the `publish` tier of tests/e2e/distribution/release-gate-matrix.json.
// The matrix is the single policy source: this runner reads the publish-tier gates
// from it and runs them in matrix order, fail-fast. Adding, removing, or reordering
// a publish gate is done in the matrix, not here.
//
// Scope: publishability only (build, artifact checks, SBOM, tarball/packaged smokes)
// plus a fast non-flaky correctness floor (typecheck + the mcp-node vitest project).
// The full browser/jsdom test matrix that used to run here is NOT re-run: it already
// ran on this exact commit SHA in verify CI (see ci-verify-coverage.test.ts) — a
// release tag always points at a main-push commit that verify already validated.
// Re-running it here only re-exposed the tag to unrelated environment flakes without
// producing new correctness signal (see docs/contributing/releasing.md).
//
// The core (planSteps / runSteps) is exported and spawn-injectable so ordering and
// fail-fast behavior can be unit-tested without a real build. main() runs only when
// the file is executed directly, so importing it is side-effect free.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateMatrix } from './release-gate-matrix-schema.mjs'
import { splitCommand } from './split-command.mjs'

export const USAGE = `Usage: pnpm --filter @whiteboard/checks publish-gate

Runs the npm publish gates (the "publish" tier of
tests/e2e/distribution/release-gate-matrix.json), from the repo root, in matrix
order, fail-fast on the first non-zero exit.

Options:
  -h, --help   Show this help and exit.
`

// Build the ordered step list: every publish-tier gate from the matrix, in
// matrix order. No synthetic prerequisite is prepended — `build` is itself a
// matrix gate tagged requiredFor:"publish", so the matrix stays the single
// source of truth for step order.
export function planSteps(gates) {
  return gates
    .filter((gate) => gate.requiredFor.includes('publish'))
    .map((gate) => ({ label: gate.id, command: gate.command }))
}

// Run steps in order, fail-fast on the first non-zero exit. `spawn` is injectable
// (defaults to spawnSync) so tests can assert ordering / fail-fast without real
// processes. Returns { ok, exitCode, ranLabels } instead of calling process.exit,
// so it stays testable.
export function runSteps(steps, options = {}) {
  const { cwd, spawn = spawnSync, stdout = process.stdout, stderr = process.stderr } = options
  const ranLabels = []
  for (let i = 0; i < steps.length; i++) {
    const { label, command } = steps[i]
    stdout.write(`\n[publish-gate] step ${i + 1}/${steps.length}: ${label}\n  $ ${command}\n`)
    let argv
    try {
      argv = splitCommand(command)
    } catch (err) {
      stderr.write(`[publish-gate] invalid gate command for "${label}": ${err.message}\n`)
      return { ok: false, exitCode: 1, ranLabels }
    }
    const [cmd, ...args] = argv
    ranLabels.push(label)
    const result = spawn(cmd, args, { cwd, stdio: 'inherit' })
    if (result.error) {
      stderr.write(`[publish-gate] step "${label}" could not start: ${result.error.message}\n`)
      return { ok: false, exitCode: 1, ranLabels }
    }
    if (result.status !== 0) {
      stderr.write(`[publish-gate] step "${label}" failed (exit ${result.status})\n`)
      return { ok: false, exitCode: result.status ?? 1, ranLabels }
    }
  }
  stdout.write('\n[publish-gate] all steps passed\n')
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
// read, spawn, stdout/stderr) is injectable so a test can assert the fail-loud
// invalid-matrix path (wrong exit code, steps never run) without touching a
// real repo checkout or spawning real processes. Returns an exit code instead
// of calling process.exit, matching runSteps/verify-pack-contents' main().
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
    stderr.write(`[publish-gate] ${parsed.message}\n\n`)
    stderr.write(USAGE)
    return 1
  }
  const matrixPath = resolve(repoRoot, 'tests/e2e/distribution/release-gate-matrix.json')
  const matrix = readMatrix(matrixPath)
  // Fail loud on a structurally invalid matrix instead of silently running a
  // gate subset that drifted from the policy the matrix is supposed to encode.
  const validation = validateMatrix(matrix)
  if (!validation.ok) {
    stderr.write(`[publish-gate] invalid release-gate-matrix.json: ${validation.reason}\n`)
    return 1
  }
  const steps = planSteps(matrix.gates)
  if (steps.length === 0) {
    stderr.write('[publish-gate] no publish gates found in release-gate-matrix.json\n')
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
