// @whiteboard/checks — the one runner behind every release-gate tier.
//
// A tier is a slice of tests/e2e/distribution/release-gate-matrix.json: the
// matrix is the single policy source, so adding, removing or reordering a gate
// is done there and never in a runner. The `publish` and `pages-release`
// entry points differ only in their tier name and in whether a prerequisite
// precedes the matrix gates; they were once two hand-copied files, and the
// copy drifted (one read the matrix without validating it), which is why the
// loop, the matrix read and the validation exist here and nowhere else.
//
// createTierRunner() returns the core (planSteps / runSteps / parseArgs / main),
// spawn-injectable so ordering and fail-fast behaviour are unit-testable
// without a real build. runIfEntry() runs main() only when the entry file is
// executed directly, so importing an entry is side-effect free.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRunAsScript } from './is-run-as-script.mjs'
import { validateMatrix } from './release-gate-matrix-schema.mjs'
import { splitCommand } from './split-command.mjs'

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * @typedef {{ label: string, command: string }} Step
 * @typedef {{ write: (chunk: string) => boolean }} Sink
 * @typedef {(cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null, error?: Error }} Spawn
 */

/**
 * @param {{
 *   name: string,
 *   tier: string,
 *   description: string,
 *   prerequisites?: Step[],
 * }} config `name` is the script name and log prefix; `description` is the
 *   tier-specific paragraph of the usage text; `prerequisites` run before the
 *   matrix gates and are not matrix policy.
 */
export function createTierRunner({ name, tier, description, prerequisites = [] }) {
  const USAGE = `Usage: pnpm --filter @whiteboard/checks ${name}

${description}

Options:
  -h, --help   Show this help and exit.
`

  // Every gate of the tier in matrix order, after the prerequisites.
  function planSteps(gates) {
    return [
      ...prerequisites,
      ...gates
        .filter((gate) => gate.requiredFor.includes(tier))
        .map((gate) => ({ label: gate.id, command: gate.command })),
    ]
  }

  // Fail-fast on the first non-zero exit. Returns { ok, exitCode, ranLabels }
  // instead of exiting, so it stays testable.
  function runSteps(steps, options = {}) {
    const { cwd, spawn = spawnSync, stdout = process.stdout, stderr = process.stderr } = options
    const ranLabels = []
    for (let i = 0; i < steps.length; i++) {
      const { label, command } = steps[i]
      stdout.write(`\n[${name}] step ${i + 1}/${steps.length}: ${label}\n  $ ${command}\n`)
      let argv
      try {
        argv = splitCommand(command)
      } catch (err) {
        stderr.write(`[${name}] invalid gate command for "${label}": ${err.message}\n`)
        return { ok: false, exitCode: 1, ranLabels }
      }
      const [cmd, ...args] = argv
      ranLabels.push(label)
      const result = spawn(cmd, args, { cwd, stdio: 'inherit' })
      if (result.error) {
        stderr.write(`[${name}] step "${label}" could not start: ${result.error.message}\n`)
        return { ok: false, exitCode: 1, ranLabels }
      }
      if (result.status !== 0) {
        stderr.write(`[${name}] step "${label}" failed (exit ${result.status})\n`)
        return { ok: false, exitCode: result.status ?? 1, ranLabels }
      }
    }
    stdout.write(`\n[${name}] all steps passed\n`)
    return { ok: true, exitCode: 0, ranLabels }
  }

  // A release gate runner must not run its gates on a typo'd flag, so only a
  // no-argument invocation runs; -h/--help prints usage; anything else errors.
  function parseArgs(args) {
    if (args.includes('-h') || args.includes('--help')) return { mode: 'help' }
    if (args.length > 0)
      return { mode: 'error', message: `unexpected argument(s): ${args.join(' ')}` }
    return { mode: 'run' }
  }

  /**
   * Every I/O boundary (argv, matrix read, spawn, stdout/stderr) is injectable
   * so a test can assert the fail-loud invalid-matrix path without a real
   * checkout or real processes. Returns an exit code instead of exiting.
   * @param {{
   *   argv?: string[],
   *   repoRoot?: string,
   *   readMatrix?: (matrixPath: string) => unknown,
   *   spawn?: Spawn,
   *   stdout?: Sink,
   *   stderr?: Sink,
   * }} [options]
   * @returns {number} process exit code
   */
  function main(options = {}) {
    const {
      argv = process.argv.slice(2),
      repoRoot = DEFAULT_REPO_ROOT,
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
      stderr.write(`[${name}] ${parsed.message}\n\n`)
      stderr.write(USAGE)
      return 1
    }
    const matrix = readMatrix(resolve(repoRoot, 'tests/e2e/distribution/release-gate-matrix.json'))
    // Fail loud on a structurally invalid matrix instead of silently running a
    // gate subset that drifted from the policy the matrix is supposed to encode.
    const validation = validateMatrix(matrix)
    if (!validation.ok) {
      stderr.write(`[${name}] invalid release-gate-matrix.json: ${validation.reason}\n`)
      return 1
    }
    const steps = planSteps(matrix.gates)
    // Prerequisites alone are not a gate run: a tier no gate carries must fail
    // rather than report a green build.
    if (steps.length === prerequisites.length) {
      stderr.write(`[${name}] no ${tier} gates found in release-gate-matrix.json\n`)
      return 1
    }
    return runSteps(steps, { cwd: repoRoot, spawn, stdout, stderr }).exitCode
  }

  return { USAGE, planSteps, runSteps, parseArgs, main }
}

/** Run `main` only when `entryUrl` (the caller's `import.meta.url`) is the process entry point. */
export function runIfEntry(entryUrl, main) {
  if (isRunAsScript(entryUrl)) {
    process.exit(main())
  }
}
