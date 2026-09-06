// `pnpm --filter @kamiazya/whiteboard-web test` has to keep meaning "the whole
// apps/web suite", and CI's shard has to actually reach both halves. Three
// things can quietly take that away, none of them visible in the output:
//
//   - dropping the second run, leaving web-node's build/deploy guards
//     unexecuted while the command still reports success;
//   - dropping the argument passthrough, which would make CI's `--shard` a
//     no-op — every shard runs every file, the job gets SLOWER, and nothing
//     is red;
//   - forwarding pnpm's own `--` separator, which does the same thing for a
//     different reason (cac parks everything after it in `options['--']`).
//
// The third is not hypothetical: it is what this wrapper did on its first
// day. `--shard=1/2` reported the same 372 files as an unsharded run, which
// reads exactly like a shard that ran.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain .mjs script, imported for the one pure function
// its behaviour hangs on; there are no types to generate for a CI wrapper.
import { RUNS, vitestArgv } from './run-web-tests.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webPackageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>
}

describe('the apps/web test wrapper runs the whole suite', () => {
  it('is what `test` invokes', () => {
    expect(webPackageJson.scripts.test).toBe('node scripts/run-web-tests.mjs')
  })

  it('runs both configs, not just the jsdom one', () => {
    // The jsdom project is vitest's default config here; the node one is named.
    const labels = (RUNS as { label: string; args: string[] }[]).map((run) => run.label)
    expect(labels).toEqual(['web-jsdom', 'web-node'])
    expect((RUNS as { args: string[] }[])[1].args).toContain('vitest.node.config.ts')
  })

  it('forwards caller arguments to every run', () => {
    for (const { args } of RUNS as { args: string[] }[]) {
      expect(vitestArgv(args, ['--shard=1/2'])).toEqual([...args, '--shard=1/2'])
    }
  })

  it("strips pnpm's separator so --shard is not parked behind it", () => {
    // What `pnpm --filter … test -- --shard=1/2` actually hands the wrapper.
    expect(vitestArgv(['run'], ['--', '--shard=1/2'])).toEqual(['run', '--shard=1/2'])
  })

  it('keeps an argument that merely starts with dashes', () => {
    // Only the bare separator goes; `--silent` and friends are the point.
    expect(vitestArgv(['run'], ['--', '--silent', '--shard=2/2'])).toEqual([
      'run',
      '--silent',
      '--shard=2/2',
    ])
  })

  it('stops at the first failing half', () => {
    const source = readFileSync(join(__dirname, 'run-web-tests.mjs'), 'utf-8')
    expect(source).toMatch(/if \(result\.status !== 0\) process\.exit/)
  })
})
