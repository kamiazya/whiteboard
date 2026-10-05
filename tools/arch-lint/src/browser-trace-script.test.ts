// `pnpm test:browser:trace` records a Playwright trace with DOM snapshots for
// every test it runs, about 22GB over the whole browser suite. The script
// behind it asks vitest which files the arguments select and refuses more than
// a few, before a run starts; this pins the refusal, the run it still allows,
// and that the package script is routed through it at all.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const SCRIPT = join(REPO_ROOT, 'tools/checks/src/browser-trace.mjs')

type Spawned = { cmd: string; args: string[]; env: Record<string, string | undefined> }

const { main, MAX_TRACED_FILES } = (await import(pathToFileURL(SCRIPT).href)) as {
  main: (options: {
    argv: readonly string[]
    repoRoot?: string
    env?: Record<string, string>
    stderr?: { write: (chunk: string) => boolean }
    spawn?: SpawnFn
  }) => number
  MAX_TRACED_FILES: number
}

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
) => { status: number | null; stderr?: string | Buffer | null }

// What `vitest list --filesOnly` reported for the four browser projects when
// this was written: the whole suite is a few hundred files.
const WHOLE_SUITE = 300

function jsonPathOf(args: readonly string[]): string {
  const flag = args.find((arg) => arg.startsWith('--json='))
  if (!flag) throw new Error(`list call without --json=<path>: ${args.join(' ')}`)
  return flag.slice('--json='.length)
}

function isListCall(args: readonly string[]): boolean {
  return args[0] === 'exec' && args[1] === 'vitest' && args[2] === 'list'
}

/**
 * Runs `main` against a stand-in for vitest: a `list` call answers with
 * `selected` files the way vitest does (a JSON array written to the `--json`
 * path), and a `run` call is recorded, never executed.
 */
function runMain(argv: readonly string[], selected: number | 'fail' = WHOLE_SUITE) {
  const lists: Spawned[] = []
  const runs: Spawned[] = []
  const errors: string[] = []
  const code = main({
    argv,
    env: { PATH: '/nowhere' },
    stderr: { write: (chunk) => errors.push(chunk) > 0 },
    spawn: (cmd, args, opts) => {
      if (!isListCall(args)) {
        runs.push({ cmd, args, env: opts.env })
        return { status: 0 }
      }
      lists.push({ cmd, args, env: opts.env })
      if (selected === 'fail') return { status: 1, stderr: 'Collect Error: boom' }
      const files = Array.from({ length: selected }, (_, i) => ({
        file: `/repo/f${i}.browser.test.tsx`,
        projectName: 'web-browser (chromium)',
      }))
      writeFileSync(jsonPathOf(args), JSON.stringify(files))
      return { status: 0 }
    },
  })
  return { code, lists, runs, stderr: errors.join('') }
}

describe('browser-trace refuses a run that selects the whole suite', () => {
  it.each([
    [[]],
    [['--']],
    [['--reporter', 'verbose']],
    [['-t', 'saves the document']],
    [['--testNamePattern', 'saves the document']],
    [['--outputFile', 'report.json']],
    [['--project', 'web-browser']],
    [['--bail=1']],
    [['--testTimeout', '60000']],
    [['--retry', '2']],
    [['--bail', '1']],
    [['--maxWorkers', '2']],
    [['apps/web']],
  ])('exits non-zero without starting a run for %j', (argv) => {
    const r = runMain(argv)
    expect(r.code).not.toBe(0)
    expect(r.runs).toEqual([])
    expect(r.lists).toHaveLength(1)
    expect(r.stderr).toContain(`selects ${WHOLE_SUITE} test files`)
    expect(r.stderr).toContain('pnpm test:browser:trace <path/to/failing.browser.test.tsx>')
  })

  it('refuses one file past the ceiling and allows the ceiling itself', () => {
    expect(runMain(['some/dir'], MAX_TRACED_FILES + 1).runs).toEqual([])
    expect(runMain(['some/dir'], MAX_TRACED_FILES).runs).toHaveLength(1)
  })

  it('refuses when vitest cannot say what the arguments select', () => {
    const r = runMain(['a.browser.test.tsx'], 'fail')
    expect(r.code).not.toBe(0)
    expect(r.runs).toEqual([])
    expect(r.stderr).toContain('Collect Error: boom')
  })
})

describe('browser-trace runs the file it is pointed at', () => {
  it('traces every browser project with snapshots on, filtered to that file', () => {
    const file = 'apps/web/src/components/context-menu.browser.test.tsx'
    const r = runMain(['--', file, '-t', 'opens'], 1)
    expect(r.code).toBe(0)
    expect(r.runs).toHaveLength(1)
    const [run] = r.runs
    expect(run?.cmd).toBe('pnpm')
    expect(run?.args.slice(0, 3)).toEqual(['exec', 'vitest', 'run'])
    expect(run?.args).toEqual(
      expect.arrayContaining([
        '--project=web-browser',
        '--project=web-browser-window-state',
        '--project=canvas-viewer-browser',
        '--project=canvas-render-browser',
        '--browser.trace=on',
        file,
        '-t',
        'opens',
      ]),
    )
    expect(run?.args).not.toContain('--')
    expect(run?.env.WHITEBOARD_TRACE_SNAPSHOTS).toBe('1')
    expect(run?.env.PATH).toBe('/nowhere')
  })

  it('asks vitest about exactly the projects and arguments it then runs', () => {
    const argv = ['a.browser.test.tsx', '--testTimeout', '60000', '-t', 'x']
    const r = runMain(argv, 1)
    const [list] = r.lists
    const [run] = r.runs
    const selection = (args: readonly string[]) =>
      args.filter((arg) => arg.startsWith('--project=') || argv.includes(arg))
    expect(list?.args.slice(0, 4)).toEqual(['exec', 'vitest', 'list', '--filesOnly'])
    expect(selection(list?.args ?? [])).toEqual(selection(run?.args ?? []))
    expect(selection(run?.args ?? [])).toHaveLength(4 + argv.length)
  })
})

// The decision is vitest's own reading of the arguments, so the stand-in above
// can only model it. This asks the real vitest once, with the option value the
// hand-kept option table used to mistake for a file filter, which also proves
// the real list's JSON is read. A run is recorded, never started. One case
// only: it runs at pre-push, and each is a config load of the four browser
// projects, 11-28s measured at a load average of 15-25 — near enough the
// project's 60s ceiling under a `git push`'s load that it carries its own.
describe('browser-trace against the real vitest list', { timeout: 150_000 }, () => {
  function realList(argv: readonly string[]) {
    const runs: string[][] = []
    const errors: string[] = []
    const code = main({
      argv,
      repoRoot: REPO_ROOT,
      env: { ...process.env } as Record<string, string>,
      stderr: { write: (chunk) => errors.push(chunk) > 0 },
      spawn: (cmd, args, opts) => {
        if (!isListCall(args)) {
          runs.push(args)
          return { status: 0 }
        }
        return spawnSync(cmd, args, { ...opts, encoding: 'utf8', timeout: 120_000 })
      },
    })
    return { code, runs, stderr: errors.join('') }
  }

  it('refuses --testTimeout 60000, which selects every browser test file', () => {
    const r = realList(['--testTimeout', '60000'])
    expect(r.runs).toEqual([])
    expect(r.code).not.toBe(0)
    const selected = Number(/selects (\d+) test files/.exec(r.stderr)?.[1])
    expect(selected).toBeGreaterThan(100)
  })
})

describe('the root script', () => {
  it('runs through the refusing wrapper rather than vitest directly', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:browser:trace']).toBe('node tools/checks/src/browser-trace.mjs')
  })
})

// The entry guard is reached only when node starts the file, so the refusal is
// also checked as a process: a `pnpm` on PATH stands in for vitest and records
// whether it was ever called.
describe('browser-trace as `pnpm test:browser:trace` runs it', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'browser-trace-'))
  afterAll(() => rmSync(workDir, { recursive: true, force: true }))
  let runCount = 0

  function run(args: readonly string[]) {
    runCount += 1
    const binDir = join(workDir, `bin-${runCount}`)
    mkdirSync(binDir)
    const callLog = join(binDir, 'calls.jsonl')
    writeFileSync(callLog, '')
    writeFileSync(
      join(binDir, 'pnpm'),
      `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args, snapshots: process.env.WHITEBOARD_TRACE_SNAPSHOTS }) + '\\n')
const json = args.find((arg) => arg.startsWith('--json='))
if (args[2] === 'list' && json) {
  const count = args.some((arg) => arg.endsWith('.tsx')) ? 1 : ${WHOLE_SUITE}
  fs.writeFileSync(json.slice('--json='.length), JSON.stringify(Array.from({ length: count }, (_, i) => ({ file: 'f' + i }))))
}
`,
    )
    chmodSync(join(binDir, 'pnpm'), 0o755)
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
    })
    const calls = readFileSync(callLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; snapshots?: string })
    return { status: r.status, stderr: r.stderr, calls }
  }

  it('exits non-zero on a bare run and never starts one', () => {
    const r = run([])
    expect(r.status).not.toBe(0)
    expect(r.calls.map((call) => call.args[2])).toEqual(['list'])
    expect(r.stderr).toContain(`selects ${WHOLE_SUITE} test files`)
  })

  it('starts the run for a file once vitest has listed it', () => {
    const r = run(['a.browser.test.tsx'])
    expect(r.status).toBe(0)
    expect(r.calls.map((call) => call.args[2])).toEqual(['list', 'run'])
    expect(r.calls[1]?.args).toContain('a.browser.test.tsx')
    expect(r.calls[1]?.snapshots).toBe('1')
  })
})
