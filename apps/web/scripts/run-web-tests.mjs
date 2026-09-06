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

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

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

function main() {
  const passthrough = process.argv.slice(2)
  for (const { label, args } of RUNS) {
    const result = spawnSync('vitest', vitestArgv(args, passthrough), { stdio: 'inherit' })
    if (result.error) {
      process.stderr.write(`[run-web-tests] failed to start vitest for ${label}: ${result.error}\n`)
      process.exit(1)
    }
    // Stop at the first failing half rather than running the second and
    // reporting only its status, which is what `a && b` did.
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

// Importable for its own test; still the executable CI and `pnpm test` invoke.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
