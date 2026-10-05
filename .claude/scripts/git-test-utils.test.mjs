#!/usr/bin/env node
// Coverage for git-test-utils.mjs: a scratch repo built in the isolated
// environment ignores a global git config that signs and runs hooks, and every
// test that builds one uses it. Run with: pnpm test:scripts.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isolatedGitEnv } from './git-test-utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/**
 * A global config of the kind a contributor has: commits and tags signed by a
 * program that always fails, and a hooks directory whose every hook refuses.
 */
function hostileGlobalConfig() {
  const dir = scratch('git-test-utils-hostile-')
  const hooks = join(dir, 'hooks')
  mkdirSync(hooks)
  for (const name of ['pre-commit', 'commit-msg', 'pre-push', 'post-checkout']) {
    writeFileSync(
      join(hooks, name),
      `#!/bin/sh\necho "global ${name} hook refused" >&2\nexit 1\n`,
      {
        mode: 0o755,
      },
    )
  }
  const config = join(dir, 'gitconfig')
  writeFileSync(
    config,
    [
      '[user]\n\tname = Contributor\n\temail = c@example.com',
      '[commit]\n\tgpgsign = true',
      '[tag]\n\tgpgsign = true',
      '[gpg]\n\tprogram = /bin/false',
      `[core]\n\thooksPath = ${hooks}`,
      '[push]\n\tnegotiate = true',
    ].join('\n'),
  )
  return { ...process.env, GIT_CONFIG_GLOBAL: config }
}

const run = (cwd, env, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf-8' })

test('the hostile config breaks a plain scratch commit, so the cases below reach it', (t) => {
  if (process.platform === 'win32') return t.skip('the refusing hooks are shell scripts')
  const env = hostileGlobalConfig()
  const repo = join(scratch('git-test-utils-plain-'), 'repo')
  assert.equal(run(tmpdir(), env, 'init', '-q', '-b', 'main', repo).status, 0)
  const commit = run(repo, env, 'commit', '-q', '--allow-empty', '-m', 'x')
  assert.notEqual(commit.status, 0)
  assert.match(commit.stderr, /hook refused|gpg failed/)
})

test('in the isolated environment, init, commit, tag, clone and push ignore it', (t) => {
  if (process.platform === 'win32') return t.skip('the refusing hooks are shell scripts')
  const env = isolatedGitEnv({}, hostileGlobalConfig())
  const dir = scratch('git-test-utils-isolated-')
  const origin = join(dir, 'origin')
  const work = join(dir, 'work')
  const ok = (cwd, ...args) => {
    const result = run(cwd, env, ...args)
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    return result
  }
  ok(dir, 'init', '-q', origin)
  ok(origin, 'commit', '-q', '--allow-empty', '-m', 'base')
  ok(origin, 'tag', '-a', 'v1', '-m', 'annotated')
  ok(dir, 'clone', '-q', origin, work)
  ok(work, 'checkout', '-q', '-b', 'feat')
  ok(work, 'commit', '-q', '--allow-empty', '-m', 'feat')
  ok(work, 'push', '-q', 'origin', 'feat')
  assert.equal(ok(origin, 'branch', '--show-current').stdout.trim(), 'main')
  assert.equal(ok(work, 'log', '-1', '--format=%an <%ae>').stdout.trim(), 'test <test@example.com>')
})

test('a repository-local setting still applies, and a caller’s GIT_DIR does not leak in', () => {
  const env = isolatedGitEnv(
    { EXTRA: 'kept' },
    { ...process.env, GIT_DIR: '/elsewhere/.git', GIT_CONFIG_PARAMETERS: "'core.hookspath'='/x'" },
  )
  assert.equal(env.GIT_DIR, undefined)
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined)
  assert.equal(env.EXTRA, 'kept')
  const repo = join(scratch('git-test-utils-local-'), 'repo')
  execFileSync('git', ['init', '-q', repo], { env })
  execFileSync('git', ['config', 'core.hooksPath', join(repo, 'mine')], { cwd: repo, env })
  const printed = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: repo,
    env,
    encoding: 'utf-8',
  })
  assert.equal(printed.trim(), join(repo, 'mine'))
})

test('a hook test that builds scratch repos passes under the hostile config', (t) => {
  if (process.platform === 'win32') return t.skip('the refusing hooks are shell scripts')
  // NODE_TEST_CONTEXT marks a process as a file the runner spawned; inherited,
  // the inner `--test` reports to a parent that is not listening and runs nothing.
  const { NODE_TEST_CONTEXT: _context, ...env } = hostileGlobalConfig()
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', join(here, 'pre-pr-check-base.test.mjs')],
    { cwd: repoRoot, env, encoding: 'utf-8' },
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  // Present before judged: a run of zero tests also exits 0.
  assert.match(result.stdout, /^# pass [1-9]/m)
})

/**
 * The tests `pnpm test:scripts` runs, plus the one other test that builds a
 * scratch repo from a script's directory.
 */
function scriptTests() {
  const inDir = (dir) =>
    readdirSync(join(repoRoot, dir))
      .filter((name) => name.endsWith('.test.mjs'))
      .map((name) => `${dir}/${name}`)
  return [
    ...inDir('.claude/scripts'),
    ...inDir('.claude/workflows/lib'),
    ...inDir('tests/e2e/distribution'),
    'packages/mcp-server/scripts/verify-git-hooks.test.ts',
  ]
}

test('every test that builds a scratch git repo runs git in the isolated environment', () => {
  const builders = scriptTests().filter((file) => {
    const text = readFileSync(join(repoRoot, file), 'utf-8')
    return /['"]git['"]/.test(text) && /['"](?:init|clone|commit)['"]/.test(text)
  })
  // Present before judged: a scan that found no builder would pass on nothing.
  assert.ok(builders.length >= 10, `only ${builders.length} scratch-repo tests found`)
  const unisolated = builders.filter((file) => {
    const text = readFileSync(join(repoRoot, file), 'utf-8')
    return !/git-test-utils\.mjs['"]/.test(text) || !/\bisolatedGitEnv\(/.test(text)
  })
  assert.deepEqual(
    unisolated,
    [],
    'these tests run scratch-repo git with the contributor’s global config; pass isolatedGitEnv() from .claude/scripts/git-test-utils.mjs',
  )
})
