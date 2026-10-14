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
import { afterEach, describe, expect, it, vi } from 'vitest'
import jsdomConfig from '../vitest.config.ts'
import suiteConfig from '../vitest.suite.config.ts'
// @ts-expect-error -- a plain .mjs script, imported for the one pure function
// its behaviour hangs on; there are no types to generate for a CI wrapper.
import { RUNS, reportsNoTestFiles, runAll, vitestArgv } from './run-web-tests.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webPackageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>
}

describe('the apps/web test wrapper runs the whole suite', () => {
  it('is what `test` invokes', () => {
    expect(webPackageJson.scripts.test).toBe('node scripts/run-web-tests.mjs')
  })

  it('runs both configs, not just the jsdom one', () => {
    // Each half is one project of the suite aggregate, selected by name.
    const runs = RUNS as { label: string; args: string[] }[]
    expect(runs.map((run) => run.label)).toEqual(['web-jsdom', 'web-node'])
    for (const { label, args } of runs) expect(args.slice(-2)).toEqual(['--project', label])
  })

  it("keeps the jsdom config's unhandled-error filter, which vitest reads from the root only", () => {
    // Inside an aggregate the project's own `onUnhandledError` is ignored, so
    // the post-teardown React scheduler error would fail the run.
    expect(jsdomConfig.test?.onUnhandledError).toBeTypeOf('function')
    expect(suiteConfig.test?.onUnhandledError).toBe(jsdomConfig.test?.onUnhandledError)
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
})

type FakeRun = { status: number | null; empty: boolean }

/**
 * Stands in for vitest the way it really behaves on an empty match: exit 1
 * unless `--passWithNoTests` was passed, and the "No test files found" line
 * either way.
 */
function fakeVitest(collects: Record<string, boolean>) {
  const calls: { label: string; argv: string[] }[] = []
  const run = async (label: string, argv: string[]): Promise<FakeRun> => {
    calls.push({ label, argv })
    const empty = !collects[label]
    return { status: empty && !argv.includes('--passWithNoTests') ? 1 : 0, empty }
  }
  return { calls, run }
}

describe('a file filter that only one half can match', () => {
  it('passes when the other half collected the file', async () => {
    const vitest = fakeVitest({ 'web-jsdom': true, 'web-node': false })
    expect(await runAll(['src/lib/a.test.ts'], vitest.run)).toBe(0)
    expect(vitest.calls.map((c) => c.label)).toEqual(['web-jsdom', 'web-node'])
  })

  it('passes when only the second half matches', async () => {
    const vitest = fakeVitest({ 'web-jsdom': false, 'web-node': true })
    expect(await runAll(['scripts/run-web-tests.test.ts'], vitest.run)).toBe(0)
  })

  it('fails a filter that neither half matches', async () => {
    // A typo'd path has to stay red, or a mistyped red-first run reads green.
    const vitest = fakeVitest({ 'web-jsdom': false, 'web-node': false })
    expect(await runAll(['src/lib/no-such-file.test.ts'], vitest.run)).toBe(1)
  })

  it('still fails when the half that collected the file fails', async () => {
    const calls: string[] = []
    const run = async (label: string): Promise<FakeRun> => {
      calls.push(label)
      return label === 'web-jsdom' ? { status: 1, empty: false } : { status: 0, empty: true }
    }
    expect(await runAll(['src/lib/a.test.ts'], run)).toBe(1)
    expect(calls).toEqual(['web-jsdom'])
  })

  it('leaves an unfiltered run strict, so an empty suite is red', async () => {
    const vitest = fakeVitest({ 'web-jsdom': true, 'web-node': true })
    expect(await runAll(['--shard=1/2'], vitest.run)).toBe(0)
    for (const { argv } of vitest.calls) expect(argv).not.toContain('--passWithNoTests')
  })

  it("recognises vitest's empty-match line in either exit form", () => {
    expect(reportsNoTestFiles('\n No test files found, exiting with code 0\n')).toBe(true)
    expect(reportsNoTestFiles('No test files found, exiting with code 1')).toBe(true)
    expect(reportsNoTestFiles(' Test Files  1 passed (1)')).toBe(false)
  })
})

describe('a vitest that never started', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stderrOf(error: unknown): Promise<string> {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const run = async () => ({ status: null, empty: false, error })
    return runAll([], run).then((code: number) => {
      expect(code).toBe(1)
      return write.mock.calls.map(([chunk]) => String(chunk)).join('')
    })
  }

  it('prints the spawn error with its stack', async () => {
    const error = new Error('spawn vitest ENOENT')
    const out = await stderrOf(error)
    expect(out).toContain('spawn vitest ENOENT')
    expect(out).toContain(String(error.stack).split('\n')[1]?.trim())
  })

  it('prints what a non-Error failure carried rather than [object Object]', async () => {
    const out = await stderrOf({ code: 'ENOENT' })
    expect(out).toContain('"code":"ENOENT"')
    expect(out).not.toContain('[object Object]')
  })
})
