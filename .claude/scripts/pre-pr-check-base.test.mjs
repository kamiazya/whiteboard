#!/usr/bin/env node

// Regression coverage for hooks/pre-pr-check-base.mjs's overlap rule.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The hook blocks `gh pr create` while the branch is behind origin/main —
// but only when a behind-commit touches a file the branch also touches. A
// disjoint advance merges cleanly and cannot change review context, and
// blocking on it turns a fast-merging main into a race against the
// pre-push hook's runtime. Builds a throwaway "origin" + working repo pair
// per test (not the real repo).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'hooks', 'pre-pr-check-base.mjs')

const scratchDirs = []
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function commitFile(repo, name, content, message) {
  writeFileSync(join(repo, name), content)
  git(repo, ['add', name])
  git(repo, ['commit', '-m', message, '--no-verify'])
}

/** origin repo on main + a clone sitting on a feature branch that changed feat.txt. */
function makeRepoPair() {
  const dir = mkdtempSync(join(tmpdir(), 'pre-pr-check-base-test-'))
  scratchDirs.push(dir)
  const origin = join(dir, 'origin')
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-b', 'main', origin], { encoding: 'utf-8' })
  git(origin, ['config', 'user.email', 'test@example.com'])
  git(origin, ['config', 'user.name', 'test'])
  commitFile(origin, 'base.txt', 'base\n', 'base')
  execFileSync('git', ['clone', origin, work], { encoding: 'utf-8' })
  git(work, ['config', 'user.email', 'test@example.com'])
  git(work, ['config', 'user.name', 'test'])
  git(work, ['checkout', '-b', 'feat'])
  commitFile(work, 'feat.txt', 'feature\n', 'feat change')
  return { origin, work }
}

/** Runs the hook as `gh pr create` would trigger it; returns the exit status. */
function runHook(cwd, command = 'gh pr create --title x') {
  const stdin = JSON.stringify({ tool_input: { command } })
  try {
    execFileSync('node', [scriptPath], {
      cwd,
      input: stdin,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stderr: '' }
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr ?? '') }
  }
}

test('an up-to-date branch passes', () => {
  const { work } = makeRepoPair()
  assert.equal(runHook(work).status, 0)
})

test('a disjoint advance on origin/main passes', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'unrelated.txt', 'elsewhere\n', 'disjoint advance')
  const result = runHook(work)
  assert.equal(result.status, 0)
})

test('an advance touching a file the branch also touches still blocks', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'feat.txt', 'conflicting\n', 'overlapping advance')
  const result = runHook(work)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /behind origin\/main/)
  assert.match(result.stderr, /feat\.txt/)
})

test('a command that only mentions a PR creation does not fetch or block', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'feat.txt', 'conflicting\n', 'overlapping advance')
  const result = runHook(work, "git commit -m 'note: gh pr create later'")
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  // No fetch ran, so the advance is still unknown to the clone.
  assert.equal(git(work, ['rev-list', '--count', 'feat..origin/main']), '0')
})

test('--head names the branch being published, whatever the checkout is on', () => {
  const { origin, work } = makeRepoPair()
  git(work, ['push', 'origin', 'feat'])
  commitFile(origin, 'feat.txt', 'main moved it\n', 'advance touching feat.txt')
  git(work, ['checkout', 'main'])
  const result = runHook(work, 'gh pr create --head feat --title x')
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /'feat' is 1 commit\(s\) behind origin\/main/)
})

test('a leading `cd <checkout> &&` selects that checkout even when the hook runs elsewhere', () => {
  const { origin, work } = makeRepoPair()
  commitFile(origin, 'feat.txt', 'main moved it\n', 'advance touching feat.txt')
  const elsewhere = mkdtempSync(join(tmpdir(), 'pre-pr-check-base-elsewhere-'))
  scratchDirs.push(elsewhere)
  const result = runHook(elsewhere, `cd ${work} && gh pr create --title x`)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /'feat' is 1 commit\(s\) behind origin\/main/)
})
