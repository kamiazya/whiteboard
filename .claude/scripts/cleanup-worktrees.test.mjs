#!/usr/bin/env node
// Regression coverage for cleanup-worktrees.mjs's merged/fresh detection.
// Run with: node --test .claude/scripts/cleanup-worktrees.test.mjs
//
// Builds a throwaway "origin" + working repo pair per test (not the real
// repo) and points the script at it via CLEANUP_WORKTREES_REPO_ROOT.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'cleanup-worktrees.mjs')

const scratchDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-worktrees-test-'))
  scratchDirs.push(dir)
  return dir
}

/** Sets up: bare origin, a "seed" clone used to author commits, and a
 * "repo" clone that owns .claude/worktrees (the thing under test). */
function setupRepos(scratch) {
  const originDir = join(scratch, 'origin.git')
  const seedDir = join(scratch, 'seed')
  const repoDir = join(scratch, 'repo')

  git(scratch, ['init', '--bare', '--quiet', originDir])
  git(scratch, ['clone', '--quiet', originDir, seedDir])
  git(seedDir, ['config', 'user.email', 't@example.com'])
  git(seedDir, ['config', 'user.name', 'Test'])
  git(seedDir, ['commit', '--allow-empty', '--quiet', '-m', 'A'])
  git(seedDir, ['branch', '-M', 'main'])
  git(seedDir, ['push', '--quiet', 'origin', 'main'])

  git(scratch, ['clone', '--quiet', originDir, repoDir])
  git(repoDir, ['config', 'user.email', 't@example.com'])
  git(repoDir, ['config', 'user.name', 'Test'])
  mkdirSync(join(repoDir, '.claude', 'worktrees'), { recursive: true })

  return { originDir, seedDir, repoDir }
}

function runCleanup(repoDir, extraArgs = []) {
  return execFileSync('node', [scriptPath, '--dry-run', ...extraArgs], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: { ...process.env, CLEANUP_WORKTREES_REPO_ROOT: repoDir },
  })
}

after(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keeps a stale-base fresh lane (no unique commits, but origin/main advanced) unless --include-fresh', () => {
  const scratch = makeScratch()
  const { seedDir, repoDir } = setupRepos(scratch)

  const laneDir = join(repoDir, '.claude', 'worktrees', 'lane-x')
  git(repoDir, ['worktree', 'add', '--quiet', '-b', 'lane-x', laneDir, 'origin/main'])

  // origin/main advances past the lane's branch point — the lane's tip is a
  // strict ancestor of origin/main, not equal to it, but still has no
  // unique commits of its own.
  git(seedDir, ['commit', '--allow-empty', '--quiet', '-m', 'B'])
  git(seedDir, ['push', '--quiet', 'origin', 'main'])

  const withoutFlag = runCleanup(repoDir)
  assert.match(withoutFlag, /keep lane-x/, 'stale-base fresh lane must be kept without --include-fresh')
  assert.doesNotMatch(withoutFlag, /would remove lane-x/)

  const withFlag = runCleanup(repoDir, ['--include-fresh'])
  assert.match(withFlag, /would remove lane-x/, '--include-fresh should still allow removing it')
})

test('removes a squash-merged lane whose remote branch was deleted after merge (unique commits, not an ancestor)', () => {
  const scratch = makeScratch()
  const { seedDir, repoDir } = setupRepos(scratch)

  const laneDir = join(repoDir, '.claude', 'worktrees', 'lane-squashed')
  git(repoDir, ['worktree', 'add', '--quiet', '-b', 'lane-squashed', laneDir, 'origin/main'])
  git(laneDir, ['config', 'user.email', 't@example.com'])
  git(laneDir, ['config', 'user.name', 'Test'])
  git(laneDir, ['commit', '--allow-empty', '--quiet', '-m', 'lane work'])
  // git push -u records upstream = refs/heads/lane-squashed on origin, which
  // is what marks the branch as "published" for the fallback signal below.
  git(repoDir, ['push', '--quiet', '-u', 'origin', 'lane-squashed'])

  // Simulate a squash-merge: origin/main gets a brand new commit (not an
  // ancestor-preserving merge) and the PR flow deletes the remote branch.
  git(seedDir, ['commit', '--allow-empty', '--quiet', '-m', 'squash-merged lane work'])
  git(seedDir, ['push', '--quiet', 'origin', 'main'])
  git(seedDir, ['push', '--quiet', 'origin', '--delete', 'lane-squashed'])

  const output = runCleanup(repoDir)
  assert.match(
    output,
    /would remove lane-squashed/,
    'a published lane whose remote branch was deleted after a squash-merge should be removable without --include-fresh'
  )
})
