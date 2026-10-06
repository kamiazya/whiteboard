#!/usr/bin/env node
// Coverage for hooks/post-merge-pull-main.mjs: after a `gh pr merge` the main
// checkout fast-forwards to origin/main, but only when it is ON main — pulling
// into a feature branch the integrator parked there would merge main into it.
// Run with: pnpm test:scripts. Builds a throwaway origin + clone per test (not
// the real repo) and runs the hook as a subprocess, the way the harness does.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isolatedGitEnv } from './git-test-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'hooks', 'post-merge-pull-main.mjs')

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

// stderr is captured, never echoed: git narrates clones and branch switches there, and a
// failing call still carries it in the thrown error's message.
const QUIET = ['ignore', 'pipe', 'pipe']

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: isolatedGitEnv(),
    encoding: 'utf-8',
    stdio: QUIET,
  }).trim()
}

function commitFile(repo, name, content, message) {
  writeFileSync(join(repo, name), content)
  git(repo, ['add', name])
  git(repo, ['commit', '-m', message, '--no-verify'])
}

function configureIdentity(repo) {
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
}

/** An origin on main and the clone the hook will treat as the main checkout. */
function makeRepoPair() {
  const dir = mkdtempSync(join(tmpdir(), 'post-merge-pull-main-test-'))
  scratchDirs.push(dir)
  const origin = join(dir, 'origin')
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-b', 'main', origin], { env: isolatedGitEnv(), encoding: 'utf-8' })
  configureIdentity(origin)
  commitFile(origin, 'base.txt', 'base\n', 'base')
  execFileSync('git', ['clone', origin, work], {
    env: isolatedGitEnv(),
    encoding: 'utf-8',
    stdio: QUIET,
  })
  configureIdentity(work)
  return { origin, work }
}

function runHook(cwd, input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input)
  const stdout = execFileSync('node', [scriptPath], {
    cwd,
    env: isolatedGitEnv(),
    input: stdin,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return stdout.trim()
}

const merge = { tool_input: { command: 'gh pr merge 12 --squash' } }

test('a command that is not a merge is ignored without output', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'next.txt', 'next\n', 'next')
  assert.equal(runHook(work, { tool_input: { command: 'gh pr view 12' } }), '')
  assert.equal(git(work, ['log', '--oneline', '-1']).includes('next'), false)
})

test('a commit message that mentions a merge does not pull', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'next.txt', 'next\n', 'next')
  const command = "git commit -m 'note: gh pr merge 12 later'"
  assert.equal(runHook(work, { tool_input: { command } }), '')
  assert.equal(git(work, ['log', '--oneline', '-1']).includes('next'), false)
})

test('unparseable hook input is ignored without output', () => {
  const { work } = makeRepoPair()
  assert.equal(runHook(work, 'not json'), '')
})

test('a merge fast-forwards a main checkout that sits on main', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'merged.txt', 'merged\n', 'squash of the merged PR')

  const out = runHook(work, merge)

  assert.match(out, /local main synced: .* squash of the merged PR/)
  assert.match(git(work, ['log', '--oneline', '-1']), /squash of the merged PR/)
})

test('a main checkout parked on another branch is left alone and says so', () => {
  const { origin, work } = makeRepoPair()
  git(work, ['checkout', '-b', 'feat'])
  commitFile(origin, 'merged.txt', 'merged\n', 'squash of the merged PR')
  const before = git(work, ['rev-parse', 'HEAD'])

  const out = runHook(work, merge)

  assert.match(out, /main checkout is on 'feat', skipping pull/)
  assert.equal(git(work, ['rev-parse', 'HEAD']), before)
  assert.equal(git(work, ['rev-parse', 'main']), before)
})

test('a diverged main reports the skipped pull instead of failing the session', () => {
  const { origin, work } = makeRepoPair()
  // A plain pull would merge here; only `--ff-only` makes the hook refuse.
  git(work, ['config', 'pull.rebase', 'false'])
  commitFile(origin, 'theirs.txt', 'theirs\n', 'origin side')
  commitFile(work, 'ours.txt', 'ours\n', 'local side')

  const out = runHook(work, merge)

  assert.match(out, /pull skipped: /)
  assert.match(git(work, ['log', '--oneline', '-1']), /local side/)
})

test('a pile of lanes under .claude/worktrees earns the cleanup notice', () => {
  const { work } = makeRepoPair()
  for (const lane of ['a', 'b', 'c', 'd', 'e']) {
    mkdirSync(join(work, '.claude', 'worktrees', lane), { recursive: true })
  }

  assert.match(runHook(work, merge), /5 worktrees under \.claude\/worktrees/)
})

test('a few lanes are the normal working shape and earn no notice', () => {
  const { work } = makeRepoPair()
  for (const lane of ['a', 'b']) {
    mkdirSync(join(work, '.claude', 'worktrees', lane), { recursive: true })
  }

  assert.doesNotMatch(runHook(work, merge), /worktrees under/)
})

test('the REST merge a web session makes syncs main exactly as gh pr merge does', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'merged.txt', 'merged\n', 'squash of the merged PR')
  const command = 'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash'
  assert.match(runHook(work, { tool_input: { command } }), /local main synced: .* squash/)
})

test('a REST read of the merge endpoint is not a merge', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'next.txt', 'next\n', 'next')
  const command = 'gh api repos/{owner}/{repo}/pulls/12/merge'
  assert.equal(runHook(work, { tool_input: { command } }), '')
  assert.equal(git(work, ['log', '--oneline', '-1']).includes('next'), false)
})
