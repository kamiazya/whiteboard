#!/usr/bin/env node
// Regression coverage for cleanup-worktrees.mjs's merged/fresh detection.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// Builds a throwaway "origin" + working repo pair per test (not the real
// repo) and points the script at it via CLEANUP_WORKTREES_REPO_ROOT.

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

test('never removes the worktree the caller is standing in', () => {
  const scratch = makeScratch()
  const { seedDir, repoDir } = setupRepos(scratch)

  const laneDir = join(repoDir, '.claude', 'worktrees', 'lane-here')
  git(repoDir, ['worktree', 'add', '--quiet', '-b', 'lane-here', laneDir, 'origin/main'])
  git(laneDir, ['config', 'user.email', 't@example.com'])
  git(laneDir, ['config', 'user.name', 'Test'])
  git(laneDir, ['commit', '--allow-empty', '--quiet', '-m', 'lane work'])
  git(repoDir, ['push', '--quiet', '-u', 'origin', 'lane-here'])
  git(seedDir, ['commit', '--allow-empty', '--quiet', '-m', 'squash-merged lane work'])
  git(seedDir, ['push', '--quiet', 'origin', 'main'])
  git(seedDir, ['push', '--quiet', 'origin', '--delete', 'lane-here'])

  // From the main checkout it is removable — every other signal says reclaim.
  assert.match(runCleanup(repoDir), /would remove lane-here/)

  // From inside it, removing would delete the caller's own cwd. Merging a PR
  // from within its own lane is the normal way this flow runs.
  const fromInside = execFileSync('node', [scriptPath, '--dry-run'], {
    cwd: laneDir,
    encoding: 'utf-8',
    env: { ...process.env, CLEANUP_WORKTREES_REPO_ROOT: repoDir },
  })
  assert.match(fromInside, /keep lane-here: it is the current working directory/)
  assert.doesNotMatch(fromInside, /would remove lane-here/)
})

test('finds the main checkout when invoked through a linked worktree copy', () => {
  // The bug this pins: `__dirname/../..` is the main checkout only when the
  // script is reached through the main checkout's own copy. Run through a
  // linked worktree's copy, it resolved to that worktree — which has no
  // .claude/worktrees of its own — and the script printed "nothing to clean"
  // and exited 0. A silent no-op that reads exactly like success.
  const scratch = makeScratch()
  const { seedDir, repoDir } = setupRepos(scratch)

  const laneDir = join(repoDir, '.claude', 'worktrees', 'lane-merged')
  git(repoDir, ['worktree', 'add', '--quiet', '-b', 'lane-merged', laneDir, 'origin/main'])
  git(laneDir, ['config', 'user.email', 't@example.com'])
  git(laneDir, ['config', 'user.name', 'Test'])
  git(laneDir, ['commit', '--allow-empty', '--quiet', '-m', 'lane work'])
  git(repoDir, ['push', '--quiet', '-u', 'origin', 'lane-merged'])
  git(seedDir, ['commit', '--allow-empty', '--quiet', '-m', 'squash-merged lane work'])
  git(seedDir, ['push', '--quiet', 'origin', 'main'])
  git(seedDir, ['push', '--quiet', 'origin', '--delete', 'lane-merged'])

  // A second lane, holding the copy of the script we invoke — standing in
  // for "the session is working inside a worktree".
  const hostDir = join(repoDir, '.claude', 'worktrees', 'lane-host')
  git(repoDir, ['worktree', 'add', '--quiet', '-b', 'lane-host', hostDir, 'origin/main'])
  const hostScripts = join(hostDir, '.claude', 'scripts')
  mkdirSync(hostScripts, { recursive: true })
  const hostScript = join(hostScripts, 'cleanup-worktrees.mjs')
  copyFileSync(scriptPath, hostScript)
  copyFileSync(resolve(__dirname, 'script-flags.mjs'), join(hostScripts, 'script-flags.mjs'))

  // No CLEANUP_WORKTREES_REPO_ROOT: the script has to find the main checkout
  // itself, which is the whole point.
  const output = execFileSync('node', [hostScript, '--dry-run'], {
    cwd: hostDir,
    encoding: 'utf-8',
  })
  assert.doesNotMatch(output, /nothing to clean/, 'must not silently no-op from a linked worktree')
  assert.match(output, /would remove lane-merged/)
})

test('a real run sweeps the MCP registration a removed worktree left under the main checkout key, and a dry run does not', () => {
  const scratch = makeScratch()
  const { repoDir } = setupRepos(scratch)
  const mainRoot = realpathSync(repoDir)
  const home = join(scratch, 'home')
  mkdirSync(home)
  const claudeJson = join(home, '.claude.json')
  const proxy = (root) => `${root}/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs`
  const dead = join(mainRoot, '.claude', 'worktrees', 'gone')
  const seeded = JSON.stringify({
    projects: { [mainRoot]: { mcpServers: { whiteboard: { type: 'stdio', command: 'node', args: [proxy(dead)], env: {} } } } },
  })
  writeFileSync(claudeJson, seeded)
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLEANUP_WORKTREES_REPO_ROOT: repoDir }

  execFileSync('node', [scriptPath, '--dry-run'], { cwd: repoDir, encoding: 'utf-8', env })
  assert.equal(readFileSync(claudeJson, 'utf-8'), seeded, 'a dry run must not edit ~/.claude.json')

  const output = execFileSync('node', [scriptPath], { cwd: repoDir, encoding: 'utf-8', env })
  assert.match(output, /sweep: removed stale "whiteboard" registration/)
  assert.equal(JSON.parse(readFileSync(claudeJson, 'utf-8')).projects[mainRoot].mcpServers.whiteboard, undefined)
})

// A real run also sweeps ~/.claude.json, so point HOME at the scratch dir.
function realEnv(repoDir) {
  const home = join(dirname(repoDir), 'home')
  mkdirSync(home, { recursive: true })
  return { ...process.env, HOME: home, USERPROFILE: home, CLEANUP_WORKTREES_REPO_ROOT: repoDir }
}

function runReal(repoDir, extraArgs = [], cwd = repoDir) {
  return execFileSync('node', [scriptPath, ...extraArgs], { cwd, encoding: 'utf-8', env: realEnv(repoDir) })
}

function squashMergedLane(name, { publish = true } = {}) {
  const scratch = makeScratch()
  const { seedDir, repoDir } = setupRepos(scratch)
  const laneDir = join(repoDir, '.claude', 'worktrees', name)
  git(repoDir, ['worktree', 'add', '--quiet', '-b', name, laneDir, 'origin/main'])
  git(laneDir, ['config', 'user.email', 't@example.com'])
  git(laneDir, ['config', 'user.name', 'Test'])
  git(laneDir, ['commit', '--allow-empty', '--quiet', '-m', 'lane work'])
  if (publish) git(repoDir, ['push', '--quiet', '-u', 'origin', name])
  git(seedDir, ['commit', '--allow-empty', '--quiet', '-m', 'squash-merged lane work'])
  git(seedDir, ['push', '--quiet', 'origin', 'main'])
  if (publish) git(seedDir, ['push', '--quiet', 'origin', '--delete', name])
  return { repoDir, laneDir, seedDir }
}

test('a merged lane with uncommitted changes is kept', () => {
  const { repoDir, laneDir } = squashMergedLane('lane-dirty')
  writeFileSync(join(laneDir, 'wip.txt'), 'unsaved work')
  const out = runCleanup(repoDir)
  assert.match(out, /keep lane-dirty: uncommitted changes present/)
  assert.doesNotMatch(out, /would remove lane-dirty/)
})

test('a never-published lane with committed work is kept', () => {
  const { repoDir } = squashMergedLane('lane-local', { publish: false })
  const out = runCleanup(repoDir)
  assert.match(out, /keep lane-local: branch 'lane-local' not merged/)
  assert.doesNotMatch(out, /would remove lane-local/)
})

test('a lane whose upstream is another remote is kept when absent under origin/', () => {
  const { repoDir, laneDir } = squashMergedLane('lane-fork', { publish: false })
  git(repoDir, ['config', 'branch.lane-fork.merge', 'refs/heads/lane-fork'])
  git(repoDir, ['config', 'branch.lane-fork.remote', 'fork'])
  const out = runCleanup(repoDir)
  assert.match(out, /keep lane-fork/)
})

test('a lane whose upstream names another branch (autoSetupMerge main) is kept', () => {
  const { repoDir } = squashMergedLane('lane-tracks-main', { publish: false })
  git(repoDir, ['config', 'branch.lane-tracks-main.merge', 'refs/heads/main'])
  git(repoDir, ['config', 'branch.lane-tracks-main.remote', 'origin'])
  const out = runCleanup(repoDir)
  assert.match(out, /keep lane-tracks-main/)
})

test('a published lane whose remote branch still exists is kept', () => {
  const scratch = makeScratch()
  const { seedDir, repoDir } = setupRepos(scratch)
  const laneDir = join(repoDir, '.claude', 'worktrees', 'lane-live')
  git(repoDir, ['worktree', 'add', '--quiet', '-b', 'lane-live', laneDir, 'origin/main'])
  git(laneDir, ['config', 'user.email', 't@example.com'])
  git(laneDir, ['config', 'user.name', 'Test'])
  git(laneDir, ['commit', '--allow-empty', '--quiet', '-m', 'lane work'])
  git(repoDir, ['push', '--quiet', '-u', 'origin', 'lane-live'])
  git(seedDir, ['commit', '--allow-empty', '--quiet', '-m', 'main moves'])
  git(seedDir, ['push', '--quiet', 'origin', 'main'])
  const out = runCleanup(repoDir)
  assert.match(out, /keep lane-live: branch 'lane-live' not merged and remote still exists/)
})

test('without --dry-run the merged lane directory and branch are really removed', () => {
  const { repoDir, laneDir } = squashMergedLane('lane-gone')
  const out = runReal(repoDir)
  assert.match(out, /removed lane-gone/)
  assert.equal(existsSync(laneDir), false)
  assert.equal(git(repoDir, ['branch', '--list', 'lane-gone']), '')
})

test('without --dry-run a dirty merged lane survives', () => {
  const { repoDir, laneDir } = squashMergedLane('lane-dirty2')
  writeFileSync(join(laneDir, 'wip.txt'), 'unsaved work')
  runReal(repoDir)
  assert.equal(existsSync(join(laneDir, 'wip.txt')), true)
})

test('without --dry-run the standing-in worktree is not deleted', () => {
  const { repoDir, laneDir } = squashMergedLane('lane-here2')
  runReal(repoDir, [], laneDir)
  assert.equal(existsSync(laneDir), true)
})

test('--dry-run removes nothing', () => {
  const { repoDir, laneDir } = squashMergedLane('lane-dry')
  runCleanup(repoDir)
  assert.equal(existsSync(laneDir), true)
})

// `git worktree prune` deletes the admin entry of a worktree whose directory is gone — which, for
// one on an unmounted or moved path, is not debris. A dry run reports; it does not delete.
test('--dry-run leaves the admin entry of a worktree whose directory is gone', () => {
  const scratch = makeScratch()
  const { repoDir } = setupRepos(scratch)
  const elsewhere = join(scratch, 'elsewhere')
  git(repoDir, ['worktree', 'add', '--quiet', '-b', 'lane-gone-dir', elsewhere, 'origin/main'])
  rmSync(elsewhere, { recursive: true, force: true })
  const adminEntry = join(repoDir, '.git', 'worktrees', 'elsewhere')
  assert.equal(existsSync(adminEntry), true)

  runCleanup(repoDir)
  assert.equal(existsSync(adminEntry), true, '--dry-run pruned a worktree admin entry')

  runReal(repoDir)
  assert.equal(existsSync(adminEntry), false, 'a real run prunes it')
})

test('a real run launched from a subdirectory of a merged lane leaves that lane in place', () => {
  const { repoDir, laneDir } = squashMergedLane('lane-sub')
  const sub = join(laneDir, 'nested')
  mkdirSync(sub)
  runReal(repoDir, [], sub)
  assert.equal(existsSync(sub), true)
})

// An unrecognised option must never read as consent to the destructive default: `--dryrun` is a
// typo for a dry run, and `--help` is a question.
test('--help and an unrecognised option print usage and touch nothing: no fetch, no removal', () => {
  for (const flag of ['--help', '--bogus', '--dryrun', '-n']) {
    const { repoDir, laneDir } = squashMergedLane(`lane-flag${flag.replace(/\W/g, '')}`)
    const mainBefore = git(repoDir, ['rev-parse', 'origin/main'])
    const result = spawnSync('node', [scriptPath, flag], { cwd: repoDir, encoding: 'utf-8', env: realEnv(repoDir) })

    assert.equal(result.status, flag === '--help' ? 0 : 2, `${flag}: ${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /usage: cleanup-worktrees/, flag)
    assert.doesNotMatch(result.stdout, /removed lane|done:/, flag)
    assert.equal(existsSync(laneDir), true, `${flag} removed a worktree`)
    assert.equal(git(repoDir, ['rev-parse', 'origin/main']), mainBefore, `${flag} fetched`)
  }
})
