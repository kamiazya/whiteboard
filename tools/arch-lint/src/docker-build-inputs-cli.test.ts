// ci.yml's dry-run-docker job runs docker-build-inputs.mjs as a process and
// gates the image build on what it prints. docker-build-inputs.test.ts pins
// the pure functions; this file pins the CLI that composes them — the diff it
// reads, which paths it drops as inert, the `always` short-circuit, the
// fail-open answer, and the $GITHUB_OUTPUT line — against throwaway git
// repositories, so a wrong composition (an inert filter that drops a
// dependency edit, say) is a red test rather than a silently skipped build.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const CLI = join(REPO_ROOT, 'tools/checks/src/docker-build-inputs.mjs')

const workDir = mkdtempSync(join(tmpdir(), 'docker-build-inputs-cli-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

// A HOME of its own, so neither the user's git config nor their hooks reach
// the throwaway repositories.
const ISOLATED_ENV = { PATH: process.env.PATH ?? '', HOME: workDir, GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: ISOLATED_ENV },
  )
}

function put(cwd: string, rel: string, text: string) {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true })
  writeFileSync(join(cwd, rel), text)
}

const appManifest = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: '@t/app', version: '1.0.0', dependencies: {}, ...extra }, null, 2)}\n`

let repoCount = 0
/**
 * A repository whose image builds `@t/app`, with `@t/other` outside the
 * closure; `main` holds the base and the checked-out branch one commit `edit`
 * makes on top of it.
 */
function repoWith(edit: (cwd: string) => void): string {
  repoCount += 1
  const cwd = join(workDir, `repo-${repoCount}`)
  mkdirSync(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  put(cwd, 'Dockerfile.server', 'FROM node\nRUN pnpm --filter @t/app build\n')
  put(cwd, 'package.json', '{"name":"root","private":true}\n')
  put(cwd, 'packages/app/package.json', appManifest())
  put(cwd, 'packages/app/src/a.ts', 'export const a = 1\n')
  put(cwd, 'packages/other/package.json', '{"name":"@t/other","version":"1.0.0"}\n')
  put(cwd, 'packages/other/src/y.ts', 'export const y = 1\n')
  put(cwd, 'docs/x.md', 'x\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'base')
  git(cwd, 'checkout', '-q', '-b', 'change')
  edit(cwd)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'change')
  return cwd
}

/** Run the CLI in `cwd` as the CI step does, with $GITHUB_OUTPUT set unless told otherwise. */
function answer(cwd: string, args: string[], { githubOutput = true } = {}) {
  const outputPath = join(cwd, '.github-output')
  rmSync(outputPath, { force: true })
  const env = githubOutput ? { ...ISOLATED_ENV, GITHUB_OUTPUT: outputPath } : ISOLATED_ENV
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
  let output = ''
  try {
    output = readFileSync(outputPath, 'utf8')
  } catch {
    // No file means nothing was appended, which the assertions read as ''.
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output }
}

describe('docker-build-inputs decides from the diff against the base', () => {
  it('skips a change that cannot reach the image, and records it for the job', () => {
    const r = answer(
      repoWith((cwd) => put(cwd, 'docs/x.md', 'changed\n')),
      ['main'],
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('false\n')
    expect(r.output).toBe('docker=false\n')
    expect(r.stderr).toBe(
      '[docker-build-inputs] docker=false (1 material path(s) against 1 closure package(s))\n',
    )
  })

  it('skips a source change in a package outside the compile closure', () => {
    const r = answer(
      repoWith((cwd) => put(cwd, 'packages/other/src/y.ts', 'export const y = 2\n')),
      ['main'],
    )
    expect(r.stdout).toBe('false\n')
  })

  it('builds for a source change inside the closure', () => {
    const r = answer(
      repoWith((cwd) => put(cwd, 'packages/app/src/a.ts', 'export const a = 2\n')),
      ['main'],
    )
    expect(r.stdout).toBe('true\n')
    expect(r.output).toBe('docker=true\n')
  })

  it('drops a version-only manifest bump as inert and says so', () => {
    const r = answer(
      repoWith((cwd) => put(cwd, 'packages/app/package.json', appManifest({ version: '1.0.1' }))),
      ['main'],
    )
    expect(r.stdout).toBe('false\n')
    expect(r.stderr).toBe(
      '[docker-build-inputs] docker=false (0 material path(s) against 1 closure package(s); ' +
        '1 inert (version bump / changelog))\n',
    )
  })

  it('builds for a dependency edit in a manifest, which no inert rule may drop', () => {
    const r = answer(
      repoWith((cwd) =>
        put(cwd, 'packages/app/package.json', appManifest({ dependencies: { zod: '^4.0.0' } })),
      ),
      ['main'],
    )
    expect(r.stdout).toBe('true\n')
  })

  it('builds when Dockerfile.server declares no pnpm --filter build, failing open', () => {
    const r = answer(
      repoWith((cwd) => put(cwd, 'Dockerfile.server', 'FROM node\n')),
      ['main'],
    )
    expect(r.stdout).toBe('true\n')
    expect(r.stderr).toContain('Dockerfile.server declares no pnpm --filter build')
  })
})

describe('docker-build-inputs answers true without a diff to read', () => {
  const docsOnly = repoWith((cwd) => put(cwd, 'docs/x.md', 'changed\n'))

  it('builds without diffing when told the base is `always`', () => {
    const r = answer(docsOnly, ['always'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('true\n')
    expect(r.stderr).toBe('[docker-build-inputs] docker=true (no PR base to diff against)\n')
  })

  it('fails open, naming why, when no base is given', () => {
    const r = answer(docsOnly, [])
    expect(r.stdout).toBe('true\n')
    expect(r.stderr).toContain('failing open: missing <base-ref> argument')
  })

  it('fails open when the base cannot be resolved', () => {
    const r = answer(docsOnly, ['no-such-ref'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('true\n')
  })

  it('answers on stdout alone when $GITHUB_OUTPUT is unset', () => {
    const r = answer(docsOnly, ['main'], { githubOutput: false })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('false\n')
    expect(r.output).toBe('')
  })
})

describe('docker-build-inputs as a module', () => {
  it('prints nothing when imported rather than run', () => {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(CLI).href)})`],
      { cwd: workDir, encoding: 'utf8', env: ISOLATED_ENV },
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })
})
