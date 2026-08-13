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

/**
 * The MAIN checkout, found from wherever this runs.
 *
 * `__dirname/../..` is only the main checkout when the script is invoked
 * through the main checkout's own copy — and a session normally sits inside
 * a linked worktree, whose `.claude/worktrees` does not exist (it is
 * gitignored, so a fresh worktree has none). The script then printed
 * "nothing to clean" and exited 0: a silent no-op that looks exactly like
 * success, which is how sixteen worktrees accumulated while the tool
 * "worked".
 *
 * `--git-common-dir` resolves to the MAIN repository's `.git` from any
 * linked worktree, so its parent is the main checkout.
 */
function findMainCheckout() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: __dirname,
      encoding: 'utf-8',
    }).trim()
    return dirname(commonDir)
  } catch {
    return resolve(__dirname, '../..')
  }
}

// Overridable so tests can point the script at a throwaway git repo instead
// of the real one this file lives in.
const repoRoot = process.env.CLEANUP_WORKTREES_REPO_ROOT
  ? resolve(process.env.CLEANUP_WORKTREES_REPO_ROOT)
  : findMainCheckout()
const worktreesDir = join(repoRoot, '.claude', 'worktrees')
const dryRun = process.argv.includes('--dry-run')
const storePrune = process.argv.includes('--store-prune')
const includeFresh = process.argv.includes('--include-fresh')
// Resolved once: a worktree containing this path is never a removal candidate.
const cwd = resolve(process.cwd())

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

  // A tip that is an ancestor of origin/main (including tip === mainTip) has
  // no unique commits ahead of main — that covers both a freshly-created
  // lane with no work yet AND a "stale-base" lane branched from an older
  // origin/main that has since advanced. Either way there may still be a
  // RUNNING dev-loop that just hasn't committed yet, so keep it unless
  // --include-fresh explicitly opts in.
  let noUniqueCommits = false
  try {
    git(['merge-base', '--is-ancestor', tip, 'origin/main'])
    noUniqueCommits = true
  } catch {
    noUniqueCommits = false
  }

  if (noUniqueCommits && !includeFresh) {
    console.log(`keep ${entry.name}: no unique commits ahead of origin/main (fresh/stale-base lane; use --include-fresh to remove)`)
    kept++
    continue
  }

  let merged = noUniqueCommits
  if (!merged) {
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

  // Never remove the worktree the caller is standing in. Its branch is
  // merged and its tree is clean, so every other check says "reclaim it" —
  // and `git worktree remove --force` would then delete the current working
  // directory out from under the shell that asked for the cleanup. Merging a
  // PR from inside its own lane is the normal way this flow runs.
  if (cwd === wt || cwd.startsWith(`${wt}/`)) {
    console.log(`keep ${entry.name}: it is the current working directory`)
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
