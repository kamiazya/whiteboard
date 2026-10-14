#!/usr/bin/env node
// Reclaim disk from parallel-lane debris: remove .claude/worktrees/* whose
// branch is already merged into origin/main (or whose tip is reachable from
// it) and carries no uncommitted changes, delete the local branch, prune
// worktree metadata, and optionally prune the pnpm store.
//
//   node .claude/scripts/cleanup-worktrees.mjs [--dry-run] [--store-prune] [--include-fresh]
//
// --dry-run still runs `git fetch origin --prune`, which only moves remote-tracking refs (the
// merged-status signal) and touches no worktree; it removes, prunes and sweeps nothing.
//
// It also drops the `whiteboard` MCP registration (~/.claude.json) of a worktree that no longer
// exists, which `wire-worktree-mcp.mjs --sweep` finds.
//
// Safety: a worktree with uncommitted changes or an unmerged branch is always
// left alone and reported — nothing here ever discards work.
//
// A worktree's dev daemon is stopped before the worktree is removed: it runs
// with no idle timeout, and its record lives in the worktree's own data dir,
// so once the directory is gone nothing can find it to stop it.
//
// It also sweeps vitest's scratch directories out of the OS temp dir: a run
// that is killed before it closes leaves `<tmpdir>/<21-char id>/{ssr,client}`
// copies of every transformed module (3-80 MB each), and nothing else ever
// removes them. Only directories untouched for a day are taken, so a run in
// progress keeps its own. The same bound sweeps the temp dirs this repo's own
// tests make, by the prefixes the tracked test source hands mkdtemp.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScriptArgs } from './script-flags.mjs'

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
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: __dirname,
        encoding: 'utf-8',
      },
    ).trim()
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
const { flags } = parseScriptArgs({
  argv: process.argv.slice(2),
  flags: ['--dry-run', '--store-prune', '--include-fresh'],
  usage:
    'usage: cleanup-worktrees.mjs [--dry-run] [--store-prune] [--include-fresh]\n  --dry-run still fetches origin (remote-tracking refs only); it removes and prunes nothing',
})
const dryRun = flags.has('--dry-run')
const storePrune = flags.has('--store-prune')
const includeFresh = flags.has('--include-fresh')
// Resolved once: a worktree containing this path is never a removal candidate.
const cwd = resolve(process.cwd())

// The stop is the one `pnpm mcp:http:stop` runs, so a pid that is not the
// daemon its record describes is never signalled.
const stopDevDaemonScript = resolve(
  __dirname,
  '../../packages/mcp-server/scripts/dev/stop-http-dev-daemon.mjs',
)

/**
 * Stops the dev daemon recorded in `<wt>/.dev-data`, if any. Answers why the
 * worktree has to stay when it could not, or null.
 */
function stopWorktreeDevDaemon(wt) {
  const dataDir = join(wt, '.dev-data')
  if (!existsSync(dataDir)) return null
  if (!existsSync(stopDevDaemonScript)) return `no stop script at ${stopDevDaemonScript}`
  try {
    const said = execFileSync(process.execPath, [stopDevDaemonScript], {
      cwd: wt,
      encoding: 'utf-8',
      env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    process.stdout.write(said)
    return null
  } catch (error) {
    return String(error.stderr || error.message).trim()
  }
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', ...opts }).trim()
}

/** vitest names its scratch directory with a default nanoid: 21 of `A-Za-z0-9_-`. */
const VITEST_SCRATCH_NAME = /^[A-Za-z0-9_-]{21}$/
const VITEST_SCRATCH_CHILDREN = new Set(['ssr', 'client'])
const VITEST_SCRATCH_MIN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Whether `path` or anything beneath it was modified at or after `cutoff`.
 * Every entry counts, files included: rewriting an existing module file bumps
 * no directory's mtime, so a live run can show up only in a nested file. Stops
 * at the first fresh entry, since a scratch dir holds hundreds of files.
 */
function touchedSince(path, cutoff) {
  if (statSync(path).mtimeMs >= cutoff) return true
  const entries = readdirSync(path, { withFileTypes: true })
  return entries.some((e) => {
    const child = join(path, e.name)
    return e.isDirectory() ? touchedSince(child, cutoff) : statSync(child).mtimeMs >= cutoff
  })
}

/**
 * Whether `dir` is a vitest scratch directory no run has written to for a day:
 * only `ssr`/`client` subdirectories, and nothing anywhere beneath it newer
 * than the bound. Anything else in the temp dir is not ours.
 */
function isStaleVitestScratch(dir, now) {
  try {
    const children = readdirSync(dir, { withFileTypes: true })
    if (children.length === 0) return false
    if (!children.every((c) => c.isDirectory() && VITEST_SCRATCH_CHILDREN.has(c.name))) return false
    return !touchedSince(dir, now - VITEST_SCRATCH_MIN_AGE_MS)
  } catch {
    return false
  }
}

function staleVitestScratch(root, now) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && VITEST_SCRATCH_NAME.test(entry.name))
      .map((entry) => join(root, entry.name))
      .filter((dir) => isStaleVitestScratch(dir, now))
  } catch {
    return []
  }
}

function sweepVitestScratch() {
  const root = tmpdir()
  let swept = 0
  for (const dir of staleVitestScratch(root, Date.now())) {
    if (dryRun) {
      console.log(`would sweep vitest scratch ${dir}`)
    } else {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`warning: could not sweep vitest scratch ${dir}: ${error.message}`)
        continue
      }
    }
    swept++
  }
  if (swept > 0) {
    console.log(
      `${dryRun ? 'would sweep' : 'swept'} ${swept} stale vitest scratch dir(s) in ${root}`,
    )
  }
}

/**
 * A test's temp dir: what this repo's tests and fixtures hand `mkdtemp` under
 * `tmpdir()`, read from the tracked source on every run so the sweep never
 * holds a list of its own to fall behind. A run killed before its cleanup
 * leaves one behind per test, and nothing else removes them.
 *
 * Test source only: a tool may leave a temp dir behind ON PURPOSE (mutate's
 * backup is the restore of a SIGKILLed run). A prefix built from a template
 * keeps its interpolations as a name segment, and one with no literal stem of
 * three characters says nothing about who made the directory, so it is
 * dropped rather than matched. `mkdtemp` appends six of `A-Za-z0-9`.
 */
const MKDTEMP_UNDER_TMPDIR =
  /mkdtemp(?:Sync)?\(\s*(?:join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['`])([^'`]*)\1\s*\)|`\$\{(?:os\.)?tmpdir\(\)\}\/([^`]*)`)/g
const TEST_SOURCE_PATH =
  /\.test\.[cm]?[jt]sx?$|(^|\/)test-utils\/|test-helpers|(^|\/)_test-|\.smoke(-impl)?\.|(^|\/)smoke\/|-smoke\.|(^|\/)e2e\//
const MIN_PREFIX_STEM = 3
/**
 * Test source whose `mkdtemp` calls are QUOTED fixture text rather than calls:
 * this script's own test writes them into a throwaway repo, and a prefix read
 * from there would sweep a directory nothing in this repo creates.
 */
const FIXTURE_ONLY_SOURCES = [':(exclude).claude/scripts/cleanup-worktrees.test.mjs']
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function repoTempDirPatterns() {
  let listing
  try {
    listing = git(['grep', '-E', '-e', 'mkdtemp(Sync)?\\(', '--', '.', ...FIXTURE_ONLY_SOURCES], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error.status === 1) return [] // git grep exits 1 when nothing matches
    throw new Error(`git grep for temp dir prefixes failed: ${error.stderr || error.message}`)
  }
  const patterns = new Map()
  for (const line of listing.split('\n')) {
    const at = line.indexOf(':')
    if (at < 0 || !TEST_SOURCE_PATH.test(line.slice(0, at))) continue
    for (const match of line.slice(at + 1).matchAll(MKDTEMP_UNDER_TMPDIR)) {
      const prefix = match[2] ?? match[3]
      const pieces = prefix.split(/\$\{[^}]*\}/)
      if (pieces[0].length < MIN_PREFIX_STEM || prefix.includes('/')) continue
      const body = pieces.map(escapeRegExp).join('[A-Za-z0-9._-]+')
      patterns.set(prefix, new RegExp(`^${body}[A-Za-z0-9]{6}$`))
    }
  }
  return [...patterns.values()]
}

function staleRepoTempDirs(root, now) {
  const patterns = repoTempDirPatterns()
  if (patterns.length === 0) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && patterns.some((p) => p.test(entry.name)))
      .map((entry) => join(root, entry.name))
      .filter((dir) => {
        try {
          return !touchedSince(dir, now - VITEST_SCRATCH_MIN_AGE_MS)
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

function sweepRepoTempDirs() {
  const root = tmpdir()
  let swept = 0
  for (const dir of staleRepoTempDirs(root, Date.now())) {
    if (dryRun) {
      console.log(`would sweep repo temp dir ${dir}`)
    } else {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`warning: could not sweep repo temp dir ${dir}: ${error.message}`)
        continue
      }
    }
    swept++
  }
  if (swept > 0) {
    console.log(`${dryRun ? 'would sweep' : 'swept'} ${swept} stale repo temp dir(s) in ${root}`)
  }
}

// Before the worktree pass, which can exit early with nothing to clean.
sweepVitestScratch()
sweepRepoTempDirs()

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

try {
  git(['rev-parse', 'origin/main'])
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
    console.log(
      `keep ${entry.name}: no unique commits ahead of origin/main (fresh/stale-base lane; use --include-fresh to remove)`,
    )
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

  const daemonStays = stopWorktreeDevDaemon(wt)
  if (daemonStays !== null) {
    console.log(`keep ${entry.name}: its dev daemon could not be stopped (${daemonStays})`)
    kept++
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

// Pruning deletes the admin entry of any worktree whose directory is missing, including one on a
// path that is merely unmounted, so a dry run leaves it for the real run.
if (!dryRun) git(['worktree', 'prune'])

// `claude mcp add --scope local` keys a worktree's registration by the main checkout, so removing
// the worktree leaves it behind pointing at a proxy script that no longer exists.
if (!dryRun) {
  try {
    const sweep = execFileSync('node', [join(__dirname, 'wire-worktree-mcp.mjs'), '--sweep'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    })
    process.stdout.write(sweep)
  } catch (error) {
    console.warn(`warning: could not sweep stale MCP registrations: ${error.message}`)
  }
}

if (storePrune && !dryRun) {
  console.log('pruning pnpm store…')
  // pnpm is a .cmd shim on Windows; execFileSync needs the exact filename.
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  execFileSync(pnpmCmd, ['store', 'prune'], { cwd: repoRoot, stdio: 'inherit' })
}

console.log(`done: ${removed} ${dryRun ? 'removable' : 'removed'}, ${kept} kept`)
