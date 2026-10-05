// `pnpm test:browser:trace` records a Playwright trace with DOM snapshots for
// every test it runs, about 22GB over the whole browser suite. The script
// behind it refuses a run that names no file, before vitest starts; this pins
// the refusal, the run it still allows, and that the package script is routed
// through it at all.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const SCRIPT = join(REPO_ROOT, 'tools/checks/src/browser-trace.mjs')

type Spawned = { cmd: string; args: string[]; env: Record<string, string | undefined> }

const { main, fileFilters } = (await import(pathToFileURL(SCRIPT).href)) as {
  main: (options: {
    argv: readonly string[]
    env?: Record<string, string>
    stderr?: { write: (chunk: string) => boolean }
    spawn?: (
      cmd: string,
      args: string[],
      opts: { env: Record<string, string | undefined> },
    ) => { status: number | null }
  }) => number
  fileFilters: (args: readonly string[]) => string[]
}

function runMain(argv: readonly string[]) {
  const spawned: Spawned[] = []
  const errors: string[] = []
  const code = main({
    argv,
    env: { PATH: '/nowhere' },
    stderr: { write: (chunk) => errors.push(chunk) > 0 },
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, env: opts.env })
      return { status: 0 }
    },
  })
  return { code, spawned, stderr: errors.join('') }
}

describe('browser-trace refuses a run that names no file', () => {
  it.each([
    [[]],
    [['--']],
    [['--reporter', 'verbose']],
    [['-t', 'saves the document']],
    [['--project', 'web-browser']],
    [['--bail=1']],
  ])('exits non-zero without starting vitest for %j', (argv) => {
    const r = runMain(argv)
    expect(r.code).not.toBe(0)
    expect(r.spawned).toEqual([])
    expect(r.stderr).toContain('pnpm test:browser:trace <path/to/failing.browser.test.tsx>')
  })
})

describe('browser-trace runs the file it is pointed at', () => {
  it('traces every browser project with snapshots on, filtered to that file', () => {
    const file = 'apps/web/src/components/context-menu.browser.test.tsx'
    const r = runMain(['--', file, '-t', 'opens'])
    expect(r.code).toBe(0)
    expect(r.spawned).toHaveLength(1)
    const [run] = r.spawned
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

  it('reads a positional argument as a filter and an option value as not one', () => {
    expect(fileFilters(['a.browser.test.tsx', '--reporter', 'verbose', '-t', 'x'])).toEqual([
      'a.browser.test.tsx',
    ])
    expect(fileFilters(['--reporter=verbose', 'context-menu'])).toEqual(['context-menu'])
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
require('node:fs').appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args: process.argv.slice(2), snapshots: process.env.WHITEBOARD_TRACE_SNAPSHOTS }) + '\\n')
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

  it('exits non-zero on a bare run and never calls pnpm', () => {
    const r = run([])
    expect(r.status).not.toBe(0)
    expect(r.calls).toEqual([])
    expect(r.stderr).toContain('refusing a trace run with no file filter')
  })

  it('calls pnpm once for a run that names a file', () => {
    const r = run(['a.browser.test.tsx'])
    expect(r.status).toBe(0)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]?.args).toContain('a.browser.test.tsx')
    expect(r.calls[0]?.snapshots).toBe('1')
  })
})
