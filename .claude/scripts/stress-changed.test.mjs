#!/usr/bin/env node
// Behaviour of stress-changed.mjs against a throwaway git repo and a PATH-shimmed `pnpm`, so no
// real vitest runs. That the plan matches CI's job is tools/arch-lint's stress-changed-parity test.
//
// Run with: pnpm test:scripts

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'stress-changed.mjs')
const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

/** A repo whose `feature` branch changed two real test files, a source file, a test under
 * `.claude/`, and deleted a test. */
function featureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'stress-changed-'))
  scratchDirs.push(dir)
  git(dir, 'init', '--quiet', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'Test')
  // Distinct non-empty contents: identical empty files read to git as a rename, hiding the deletion.
  writeFileSync(join(dir, 'gone.test.ts'), 'the deleted one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', 'base')
  git(dir, 'checkout', '--quiet', '-b', 'feature')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  for (const file of ['a.test.ts', 'b.browser.test.tsx', 'c.ts', '.claude/x.test.ts']) writeFileSync(join(dir, file), `${file}\n`)
  git(dir, 'rm', '--quiet', 'gone.test.ts')
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', 'feature')
  return dir
}

/** A `pnpm` that logs its argv and exits 1 on the call number in FAKE_PNPM_FAIL_ON. */
function pnpmShim() {
  const dir = mkdtempSync(join(tmpdir(), 'stress-changed-shim-'))
  scratchDirs.push(dir)
  const log = join(dir, 'calls.log')
  writeFileSync(
    join(dir, 'pnpm'),
    `#!/bin/sh\necho "$*" >> "${log}"\nn=$(wc -l < "${log}")\n[ "$n" = "$FAKE_PNPM_FAIL_ON" ] && exit 1\nexit 0\n`,
  )
  chmodSync(join(dir, 'pnpm'), 0o755)
  const calls = () => {
    try {
      return readFileSync(log, 'utf-8').trim().split('\n')
    } catch {
      return []
    }
  }
  return { dir, calls }
}

function run(cwd, args, { shim, failOn } = {}) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${shim?.dir ?? ''}:${process.env.PATH}`, FAKE_PNPM_FAIL_ON: String(failOn ?? 0) },
  })
}

test('--dry-run collects the changed test files only, drops deleted and .claude ones, and runs nothing', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  const result = run(repo, ['--base=main', '--dry-run'], { shim })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^plan files: 2$/m)
  assert.deepEqual(shim.calls(), [], 'a dry run must not invoke pnpm')
})

test('a run executes five fresh processes then one --repeats=3 process per leg, on exactly the changed files', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  const result = run(repo, ['--base=main'], { shim })

  assert.equal(result.status, 0, result.stderr)
  const calls = shim.calls()
  assert.equal(calls.length, 12)
  const files = 'a.test.ts b.browser.test.tsx'
  for (const [offset, project] of [
    [0, '*-browser'],
    [6, '!*-browser'],
  ]) {
    for (let i = 0; i < 5; i++) {
      assert.equal(calls[offset + i], `exec vitest run --project ${project} --fsModuleCache --passWithNoTests ${files}`)
    }
    assert.equal(calls[offset + 5], `exec vitest run --project ${project} --repeats=3 --fsModuleCache --passWithNoTests ${files}`)
  }
})

test('the first failing run stops everything and exits 1', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  const result = run(repo, ['--base=main'], { shim, failOn: 3 })

  assert.equal(result.status, 1)
  assert.equal(shim.calls().length, 3)
  assert.match(result.stderr, /FAILED at stress run 3\/5 \(browser\)/)
})

test('--only runs a single leg', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  const result = run(repo, ['--base=main', '--only=node'], { shim })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(shim.calls().length, 6)
  assert.ok(shim.calls().every((call) => call.includes("--project !*-browser")))
})

test('no changed test files is success without running anything', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  const result = run(repo, ['--base=feature'], { shim })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /nothing to stress/)
  assert.deepEqual(shim.calls(), [])
})

test('a base that does not resolve is an error, never an empty list', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  const result = run(repo, ['--base=no-such-ref'], { shim })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot list changed test files against no-such-ref/)
  assert.deepEqual(shim.calls(), [])
})

test('a dirty tracked test and an untracked test are planned, each labelled with where it came from', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  writeFileSync(join(repo, 'a.test.ts'), 'edited, not committed\n')
  writeFileSync(join(repo, 'new.test.ts'), 'brand new\n')
  writeFileSync(join(repo, 'new-source.ts'), 'not a test\n')
  const result = run(repo, ['--base=feature', '--dry-run'], { shim })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^plan files: 2$/m)
  assert.match(result.stdout, /^plan file: a\.test\.ts \(modified\)$/m)
  assert.match(result.stdout, /^plan file: new\.test\.ts \(untracked\)$/m)
  assert.doesNotMatch(result.stdout, /new-source/)
})

test('a file both committed and dirty is listed once with both sources', () => {
  const repo = featureRepo()
  writeFileSync(join(repo, 'a.test.ts'), 'edited again\n')
  const result = run(repo, ['--base=main', '--dry-run'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^plan files: 2$/m)
  assert.match(result.stdout, /^plan file: a\.test\.ts \(committed, modified\)$/m)
  assert.match(result.stdout, /^plan file: b\.browser\.test\.tsx \(committed\)$/m)
})

test('a run stresses the uncommitted tests, which is the state red-first work leaves', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  writeFileSync(join(repo, 'new.test.ts'), 'brand new\n')
  const result = run(repo, ['--base=feature', '--only=node'], { shim })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(shim.calls().length, 6)
  assert.ok(shim.calls().every((call) => call.endsWith(' new.test.ts')))
})

test('--committed-only restores the committed-diff-only list', () => {
  const repo = featureRepo()
  const shim = pnpmShim()
  writeFileSync(join(repo, 'new.test.ts'), 'brand new\n')
  const result = run(repo, ['--base=feature', '--committed-only'], { shim })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /nothing to stress/)
  assert.deepEqual(shim.calls(), [])
})

test('--help prints usage and exits 0; an unknown option or a bad --only value exits 2; nothing runs', () => {
  const repo = featureRepo()
  for (const args of [['--help'], ['--bogus'], ['--dryrun'], ['--only=jsdom'], ['--base='], ['extra']]) {
    const shim = pnpmShim()
    const result = run(repo, args, { shim })
    const label = JSON.stringify(args)
    assert.equal(result.status, args[0] === '--help' ? 0 : 2, `${label}: ${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /usage: stress-changed/, label)
    assert.deepEqual(shim.calls(), [], label)
  }
})
