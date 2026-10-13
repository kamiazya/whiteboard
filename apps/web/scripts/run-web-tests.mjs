#!/usr/bin/env node

// apps/web's suite is TWO vitest runs — the jsdom project and the node-env
// build/deploy guards — and `pnpm --filter @kamiazya/whiteboard-web test` is
// the one command that means "all of it", locally and in CI. That single
// meaning is load-bearing: .claude/rules/dev-flow.md tells readers to run this
// rather than `--project web-jsdom`, because the flag covers only the jsdom
// half and silently omits web-node's guards.
//
// CI shards this job, so both runs have to receive `--shard`. An npm script
// cannot do that — `a && b` appends the caller's extra args to `b` alone — so
// forwarding lives here instead of splitting CI into two hand-written vitest
// invocations, which would also have retired the `whiteboard-web test` marker
// that ci-verify-coverage.test.ts and vitest-projects.mjs both key on.

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { isRunAsScript } from '../../../tools/checks/src/is-run-as-script.mjs'

/** The two configs that together are "the apps/web suite". */
export const RUNS = [
  { label: 'web-jsdom', args: ['run'] },
  { label: 'web-node', args: ['run', '--config', 'vitest.node.config.ts'] },
]

/**
 * The argv one vitest run receives.
 *
 * `pnpm --filter … test -- --shard=1/2` delivers the separator ITSELF as
 * `argv[2]`, so a wrapper that forwards its argv verbatim hands vitest a bare
 * `--`. cac then parses everything after it into `options['--']` and `--shard`
 * is silently ignored: every shard runs every file, the job gets SLOWER
 * (two full suites instead of one), and nothing is red. Measured before this
 * strip existed — `--shard=1/2` reported the same 372 files as no shard at all.
 */
export function vitestArgv(args, forwarded) {
  return [...args, ...forwarded.filter((arg) => arg !== '--')]
}

/**
 * Whether the forwarded args name a file filter. Anything not starting with a
 * dash counts — including the value of a spaced option like `-t name`, which
 * only switches on the tolerant mode below, where "neither half collected a
 * file" is still red.
 */
function hasPositionalFilter(forwarded) {
  return forwarded.some((arg) => arg !== '--' && !arg.startsWith('-'))
}

/** Whether a vitest run's output reports that its filter matched no file. */
export function reportsNoTestFiles(output) {
  return /No test files found, exiting with code/.test(output)
}

/**
 * What a failed spawn says: an Error's stack (which leads with its message),
 * else the value's JSON, since `String()` of a plain object is
 * `[object Object]`. Not model's `describeThrown`: that package ships its
 * TypeScript source, whose `.js` specifiers plain Node cannot resolve.
 */
function describeStartFailure(error) {
  if (error instanceof Error) return error.stack ?? String(error)
  if (typeof error !== 'object' || error === null) return String(error)
  try {
    return JSON.stringify(error) ?? typeof error
  } catch {
    return typeof error
  }
}

/**
 * Runs both halves and answers the exit code.
 *
 * A file filter can only ever match one half — a `src/**` file is jsdom's, a
 * `scripts/**` one is web-node's — and vitest exits 1 on an empty match, so
 * without this every single-file run of "the command CI runs" was red. With a
 * filter, each half is told `--passWithNoTests` and the command fails only when
 * NEITHER half collected a file, so a typo'd path stays red. Without one, both
 * halves stay strict: an empty suite is a broken config, not a pass.
 *
 * @param {string[]} passthrough the caller's argv
 * @param {(label: string, argv: string[], detectEmpty: boolean) => Promise<{ status: number | null, empty: boolean, error?: unknown }>} runVitest
 */
export async function runAll(passthrough, runVitest) {
  const filtered = hasPositionalFilter(passthrough)
  let collected = false
  for (const { label, args } of RUNS) {
    const argv = vitestArgv(args, passthrough)
    const result = await runVitest(
      label,
      filtered ? [...argv, '--passWithNoTests'] : argv,
      filtered,
    )
    if (result.error) {
      process.stderr.write(
        `[run-web-tests] failed to start vitest for ${label}: ${describeStartFailure(result.error)}\n`,
      )
      return 1
    }
    // Stop at the first failing half rather than running the second and
    // reporting only its status, which is what `a && b` did.
    if (result.status !== 0) return result.status ?? 1
    if (!result.empty) collected = true
  }
  if (filtered && !collected) {
    process.stderr.write(
      `[run-web-tests] no test file in either half matched: ${passthrough.join(' ')}\n`,
    )
    return 1
  }
  return 0
}

/**
 * Spawns one vitest run. Only a filtered run is piped — its output has to be
 * read for the empty-match line — and it is teed back out as it arrives, with
 * colour kept when the caller's terminal has it. An unfiltered run (CI's) keeps
 * plain inherited stdio.
 */
function spawnVitest(_label, argv, detectEmpty) {
  if (!detectEmpty) {
    const result = spawnSync('vitest', argv, { stdio: 'inherit' })
    return Promise.resolve({ status: result.status, empty: false, error: result.error })
  }
  return new Promise((resolve) => {
    const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: '1' } : process.env
    const child = spawn('vitest', argv, { stdio: ['inherit', 'pipe', 'pipe'], env })
    let output = ''
    const tee = (sink) => (chunk) => {
      sink.write(chunk)
      output += chunk.toString()
    }
    child.stdout.on('data', tee(process.stdout))
    child.stderr.on('data', tee(process.stderr))
    child.on('error', (error) => resolve({ status: null, empty: false, error }))
    child.on('close', (status) =>
      resolve({ status, empty: reportsNoTestFiles(output), error: undefined }),
    )
  })
}

// Importable for its own test; still the executable CI and `pnpm test` invoke.
if (isRunAsScript(import.meta.url)) process.exit(await runAll(process.argv.slice(2), spawnVitest))
