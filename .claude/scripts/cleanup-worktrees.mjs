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

  // A tip that is an ancestor of origin/main means the lane has NO unique
  // commits — either freshly created from the current tip, or created from
  // an older main that has since advanced. This repo squash-merges, so
  // ancestry is NEVER evidence of a fold: a genuinely merged lane's tip is
  // not reachable from main. Such no-unique-work lanes may still host a
  // RUNNING dev-loop that just hasn't committed yet, so keep them unless
  // --include-fresh explicitly opts in.
  let isAncestor = false
  try {
    git(['merge-base', '--is-ancestor', tip, 'origin/main'])
    isAncestor = true
  } catch {
    /* has unique commits */
  }
  if (isAncestor && !includeFresh) {
    console.log(
      `keep ${entry.name}: no unique commits (fresh/stale-base lane; use --include-fresh to remove)`,
    )
    kept++
    continue
  }

  let merged = isAncestor // only reachable with --include-fresh
  if (!merged && branch) {
    // The only trustworthy fold signal in a squash-merge flow: the branch was
    // published (git push -u records upstream = its own name on origin) and
    // the remote side has since been deleted (gh merge --delete-branch and
    // our PR flow both do that on merge). A lane that was NEVER published
    // also has no remote ref — deleting it would destroy
    // committed-but-unpushed work, so it does not count.
    let wasPublished = false
    try {
      const mergeRef = git(['config', '--get', `branch.${branch}.merge`])
      // Also require the upstream REMOTE to be origin: in a fork workflow
      // the upstream may live on another remote, whose refs we neither
      // fetch nor prune here — treating its absence under origin/ as
      // "deleted" would force-delete a live lane. (Creating a lane from
      // origin/main auto-sets upstream to refs/heads/main via
      // branch.autoSetupMerge, so a bare "has upstream" check is not enough.)
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
