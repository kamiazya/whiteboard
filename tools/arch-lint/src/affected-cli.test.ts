// The command line ci.yml's scoped jobs run (tools/checks/src/affected-cli.mjs),
// over a synthetic git repository: two packages, one depending on the other,
// so a change to one has a dependent and a bystander.
//
// What it pins is what a job's steps rely on: `job` writes the outputs its
// gated steps read and runs everything when it cannot compute a selection,
// and `run` hands vitest only names it has checked — vitest itself drops a
// `--project` name that matches nothing as long as another one does.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

type Spawn = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => { status: number | null; error?: Error }

// lazy-import: loaded by path, since a relative import of tools/checks leaves
// this workspace and `relative-import-escape` refuses it.
const { main } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/affected-cli.mjs')).href
)) as {
  main: (
    argv: string[],
    options?: { repoRoot?: string; env?: Record<string, string | undefined>; spawn?: Spawn },
  ) => number
}

let root: string

function write(path: string, text: string) {
  mkdirSync(join(root, dirname(path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

// A git hook exports these for the repository being pushed; inherited, they
// point every git command at that repository, and the fixture's `commit`s land
// on the real branch under pre-push. Scrubbed per call, since `main` runs git
// in-process from `process.env`.
const REPO_POINTERS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']

function withoutRepoPointers<T>(run: () => T): T {
  const saved = Object.fromEntries(REPO_POINTERS.map((key) => [key, process.env[key]]))
  for (const key of REPO_POINTERS) delete process.env[key]
  try {
    return run()
  } finally {
    for (const key of REPO_POINTERS) if (saved[key] !== undefined) process.env[key] = saved[key]
  }
}

function git(...args: string[]) {
  withoutRepoPointers(() =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    }),
  )
}

function project(dir: string, name: string) {
  write(`${dir}/vitest.node.config.ts`, `export default { test: { name: '${name}' } }\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affected-cli-'))
  write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
  write('packages/base/package.json', JSON.stringify({ name: 'base' }))
  write(
    'packages/top/package.json',
    JSON.stringify({ name: 'top', devDependencies: { base: 'workspace:*' } }),
  )
  write('packages/aside/package.json', JSON.stringify({ name: 'aside' }))
  project('packages/base', 'base-node')
  project('packages/top', 'top-node')
  project('packages/aside', 'aside-node')
  write(
    'vitest.projects.json',
    JSON.stringify([
      'packages/base/vitest.node.config.ts',
      'packages/top/vitest.node.config.ts',
      'packages/aside/vitest.node.config.ts',
    ]),
  )
  write('packages/base/src/index.ts', 'export const a = 1\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run `job` and return the GITHUB_OUTPUT lines it wrote. */
function jobOutputs(args: string[]): Record<string, string> {
  const output = join(root, 'github-output')
  writeFileSync(output, '')
  expect(
    withoutRepoPointers(() =>
      main(['job', ...args], { repoRoot: root, env: { GITHUB_OUTPUT: output } }),
    ),
  ).toBe(0)
  return Object.fromEntries(
    readFileSync(output, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

describe('affected-cli job', () => {
  it("keeps its commits in the fixture under a hook's exported GIT_DIR", () => {
    const other = mkdtempSync(join(tmpdir(), 'affected-cli-other-'))
    try {
      withoutRepoPointers(() =>
        execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'ignore' }),
      )
      process.env.GIT_DIR = join(other, '.git')
      write('packages/base/src/index.ts', 'export const a = 2\n')
      git('commit', '-q', '-am', 'change base')
      const out = jobOutputs(['test-shared', '--event', 'pull_request', '--base', 'HEAD^1'])
      expect(JSON.parse(out.projects ?? '')).toEqual(['base-node', 'top-node'])
      const otherLog = execFileSync('git', ['-C', other, 'rev-list', '--all', '--count'], {
        env: { ...process.env, GIT_DIR: join(other, '.git') },
        encoding: 'utf8',
      })
      expect(otherLog.trim()).toBe('0')
    } finally {
      delete process.env.GIT_DIR
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('selects the changed package and its dependent, not the bystander, on a pull request', () => {
    write('packages/base/src/index.ts', 'export const a = 2\n')
    git('commit', '-q', '-am', 'change base')
    const out = jobOutputs(['test-shared', '--event', 'pull_request', '--base', 'HEAD^1'])
    expect(out.run).toBe('true')
    expect(JSON.parse(out.projects ?? '')).toEqual(['base-node', 'top-node'])
  })

  it('says why when the change reaches none of the job', () => {
    write('packages/aside/src/index.ts', 'export const b = 1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'aside only')
    const out = jobOutputs(['test-browser', '--event', 'pull_request', '--base', 'HEAD^1'])
    expect(out.run).toBe('false')
    expect(out.reason).toMatch(/none of .* is affected/)
  })

  it('selects everything on any other event, and when --event is missing', () => {
    for (const args of [['--event', 'push'], []]) {
      const out = jobOutputs(['test-shared', ...args])
      expect(out.run).toBe('true')
      expect(JSON.parse(out.projects ?? '')).toEqual(['aside-node', 'base-node', 'top-node'])
    }
  })

  it('runs the whole universe when the diff cannot be read', () => {
    const out = jobOutputs(['test-shared', '--event', 'pull_request', '--base', 'no-such-ref'])
    expect(out.run).toBe('true')
    expect(JSON.parse(out.projects ?? '')).toEqual(['aside-node', 'base-node', 'top-node'])
    expect(out.reason).toMatch(/selection unavailable/)
  })

  it('runs a path-scoped job for a change under its tree, and skips it otherwise', () => {
    // Each commit stages its own paths: `jobOutputs` leaves a root file that
    // `add -A` would sweep in, and an unattributed root file selects everything.
    write('crates/core/src/lib.rs', '\n')
    git('add', 'crates')
    git('commit', '-q', '-m', 'a crate')
    const out = jobOutputs(['rust', '--event', 'pull_request', '--base', 'HEAD^1'])
    expect(out.run).toBe('true')
    expect(out.reason).toContain('crates/core/src/lib.rs')
    expect(JSON.parse(out.projects ?? '')).toEqual([])
    write('packages/aside/src/index.ts', 'export const b = 1\n')
    git('add', 'packages')
    git('commit', '-q', '-m', 'aside only')
    expect(jobOutputs(['rust', '--event', 'pull_request', '--base', 'HEAD^1']).run).toBe('false')
  })

  it('refuses a job that is not scoped', () => {
    expect(main(['job', 'verify', '--event', 'push'], { repoRoot: root, env: {} })).toBe(1)
  })
})

describe('affected-cli run', () => {
  const spawned: string[][] = []
  const spawn: Spawn = (_cmd, args) => {
    spawned.push(args)
    return { status: 7 }
  }
  beforeEach(() => {
    spawned.length = 0
  })
  const run = (env: Record<string, string | undefined>, ...args: string[]) =>
    main(['run', 'test-shared', ...args], { repoRoot: root, env, spawn })

  it('hands vitest the checked names and the shard, and forwards its exit code', () => {
    expect(run({ AFFECTED_PROJECTS: '["top-node","base-node"]' }, '--', '--shard=2/2')).toBe(7)
    expect(spawned).toEqual([
      [
        'exec',
        'vitest',
        'run',
        '--project=base-node',
        '--project=top-node',
        '--shard=2/2',
        '--passWithNoTests',
      ],
    ])
  })

  it.each([
    ['unset', undefined],
    ['empty', '[]'],
    ['a name outside the universe', '["base-node","typo-node"]'],
    ['not JSON', 'base-node'],
  ])('never spawns vitest when the selection is %s', (_label, value) => {
    expect(run({ AFFECTED_PROJECTS: value })).toBe(1)
    expect(spawned).toEqual([])
  })

  it('does not pass --passWithNoTests to an unsharded run', () => {
    run({ AFFECTED_PROJECTS: '["aside-node"]' })
    expect(spawned[0]).not.toContain('--passWithNoTests')
  })
})
