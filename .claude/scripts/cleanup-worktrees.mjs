#!/usr/bin/env node
// Reclaim disk from parallel-lane debris: remove .claude/worktrees/* whose
// branch is already merged into origin/main (or whose tip is reachable from
// it) and carries no uncommitted changes, delete the local branch, prune
// worktree metadata, and optionally prune the pnpm store.
//
//   node .claude/scripts/cleanup-worktrees.mjs [--dry-run] [--store-prune] [--include-fresh]
//
// Safety: a worktree with uncommitted changes or an unmerged branch is always
// left alone and reported — nothing here ever discards work.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const worktreesDir = join(repoRoot, '.claude', 'worktrees')
const dryRun = process.argv.includes('--dry-run')
const storePrune = process.argv.includes('--store-prune')
const includeFresh = process.argv.includes('--include-fresh')

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', ...opts }).trim()
}

if (!existsSync(worktreesDir)) {
  console.log('no .claude/worktrees directory — nothing to clean')
  process.exit(0)
}

try {
  // --prune: the "remote branch deleted" fallback below reads remote-tracking
  // refs, which plain fetch never removes — without pruning, a squash-merged
  // lane whose remote branch was deleted still looks unmerged forever.
  git(['fetch', 'origin', '--prune', '--quiet'])
} catch {
  console.warn('warning: fetch from origin failed (offline?) — proceeding with local ref cache')
}

let mainTip
try {
  mainTip = git(['rev-parse', 'origin/main'])
} catch {
  console.error('error: origin/main ref not found — cannot determine merged status')
  process.exit(1)
}

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
  if (tip === mainTip && !includeFresh) {
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
    // and our PR flow both delete the remote ref on merge). But a lane that
    // was NEVER published (new-worktree.mjs creates the branch locally; only
    // `git push -u` sets an upstream) also has no remote ref — deleting it
    // would destroy committed-but-unpushed work. Only treat a missing remote
    // ref as "folded" when the branch had an upstream configured, i.e. it
    // was pushed at some point and the remote side has since been deleted.
    if (branch) {
      // "Published" means the upstream points at the branch's own name on the
      // remote (what `git push -u` records). Creating a lane from
      // origin/main auto-sets upstream to refs/heads/main via
      // branch.autoSetupMerge, so a bare "has upstream" check would misread
      // every never-pushed lane as published.
      let wasPublished = false
      try {
        const mergeRef = git(['config', '--get', `branch.${branch}.merge`])
        // Also require the upstream REMOTE to be origin: in a fork workflow
        // the upstream may live on another remote, whose refs we neither
        // fetch nor prune here — treating its absence under origin/ as
        // "deleted" would force-delete a live lane.
        const remote = git(['config', '--get', `branch.${branch}.remote`])
        wasPublished = mergeRef === `refs/heads/${branch}` && remote === 'origin'
      } catch {
        /* never published */
      }
      if (wasPublished) {
        try {
          git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
        } catch {
          merged = true // was published, remote gone → folded
        }
      }
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
  // pnpm is a .cmd shim on Windows; execFileSync needs the exact filename.
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  execFileSync(pnpmCmd, ['store', 'prune'], { cwd: repoRoot, stdio: 'inherit' })
}

console.log(`done: ${removed} ${dryRun ? 'removable' : 'removed'}, ${kept} kept`)
