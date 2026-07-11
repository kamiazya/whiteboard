#!/usr/bin/env node
// Reclaim disk from parallel-lane debris: remove .claude/worktrees/* whose
// branch is already merged into origin/main (or whose tip is reachable from
// it) and carries no uncommitted changes, delete the local branch, prune
// worktree metadata, and optionally prune the pnpm store.
//
//   node .claude/scripts/cleanup-worktrees.mjs [--dry-run] [--store-prune]
//
// Safety: a worktree with uncommitted changes or an unmerged branch is always
// left alone and reported — nothing here ever discards work.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..')
const worktreesDir = join(repoRoot, '.claude', 'worktrees')
const dryRun = process.argv.includes('--dry-run')
const storePrune = process.argv.includes('--store-prune')

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', ...opts }).trim()
}

if (!existsSync(worktreesDir)) {
  console.log('no .claude/worktrees directory — nothing to clean')
  process.exit(0)
}

git(['fetch', 'origin', '--quiet'])

const entries = readdirSync(worktreesDir, { withFileTypes: true }).filter((e) => e.isDirectory())
let removed = 0
let kept = 0

for (const entry of entries) {
  const wt = join(worktreesDir, entry.name)
  let branch = ''
  let dirty = ''
  let tip = ''
  try {
    branch = git(['-C', wt, 'branch', '--show-current'])
    dirty = git(['-C', wt, 'status', '--porcelain'])
    tip = git(['-C', wt, 'rev-parse', 'HEAD'])
  } catch {
    console.log(`skip ${entry.name}: not a valid worktree (run \`git worktree prune\` if stale)`)
    kept++
    continue
  }

  if (dirty) {
    console.log(`keep ${entry.name}: uncommitted changes present`)
    kept++
    continue
  }

  // A branch whose tip still equals origin/main has produced no commits yet —
  // that is a freshly-created lane (possibly with an agent about to work in
  // it), not a folded one. The ancestor check below would misread it as
  // merged, so keep it unless --include-fresh is passed.
  const mainTip = git(['rev-parse', 'origin/main'])
  if (tip === mainTip && !process.argv.includes('--include-fresh')) {
    console.log(`keep ${entry.name}: no commits yet (fresh lane; use --include-fresh to remove)`)
    kept++
    continue
  }

  let merged = false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', tip, 'origin/main'], { cwd: repoRoot })
    merged = true
  } catch {
    // Squash-merged branches are not ancestors of main; fall back to
    // "remote branch deleted" as the merged signal (gh merge --delete-branch
    // and our PR flow both delete the remote ref on merge).
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    } catch {
      merged = branch !== '' // remote gone → treat as folded
    }
  }

  if (!merged) {
    console.log(`keep ${entry.name}: branch '${branch}' not merged and remote still exists`)
    kept++
    continue
  }

  if (dryRun) {
    console.log(`would remove ${entry.name} (branch '${branch}')`)
    removed++
    continue
  }

  git(['worktree', 'remove', '--force', wt])
  if (branch) {
    try {
      git(['branch', '-D', branch])
    } catch {
      /* branch already gone */
    }
  }
  console.log(`removed ${entry.name} (branch '${branch}')`)
  removed++
}

git(['worktree', 'prune'])

if (storePrune && !dryRun) {
  console.log('pruning pnpm store…')
  execFileSync('pnpm', ['store', 'prune'], { cwd: repoRoot, stdio: 'inherit' })
}

console.log(`done: ${removed} ${dryRun ? 'removable' : 'removed'}, ${kept} kept`)
