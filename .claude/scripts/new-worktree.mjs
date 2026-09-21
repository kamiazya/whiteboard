#!/usr/bin/env node
// Local AI-dev-flow helper (lives under .claude/ = gitignored, like workflows/agents/skills).
// Create a ready-to-develop git worktree: branch off a base ref, then `pnpm install`
// (warm pnpm store ~6s) so tests/typecheck run isolated inside it. This is what makes
// PARALLEL dev-loops possible — each runs in its own worktree, so none contends on the
// main working tree. The integrator launches a dev-loop with cwd=<this path>, and
// reconciles the branches before folding.
//
//   node .claude/scripts/new-worktree.mjs <name> [baseRef]      (baseRef default: freshly fetched origin/main)
//
// Remove when done: git worktree remove --force .claude/worktrees/<name>
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync as nodeCpSync, existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveDevPort } from '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Auto-wires the new worktree's Claude Code session to its own derived
 * port — see wire-worktree-mcp.mjs for the mechanism (a --scope local
 * `claude mcp add` under the tracked entry's own name, which cleanly
 * shadows the tracked .mcp.json entry). This step must never abort worktree
 * setup: a missing `claude` CLI, an existing conflicting registration, or
 * even a crash in the wire script itself (e.g. a broken relative import)
 * should surface as a warning, not stop the worktree from being usable.
 *
 * @param {{ scriptPath: string, wtPath: string, spawn?: typeof spawnSync, log?: (msg: string) => void }} args
 */
export function runWireStep({ scriptPath, wtPath, spawn = spawnSync, log = (msg) => console.warn(msg) }) {
  const fallback = `Wire manually: node .claude/scripts/wire-worktree-mcp.mjs ${wtPath}`
  try {
    const result = spawn('node', [scriptPath, wtPath], { stdio: 'inherit' })
    if (result.status !== 0) {
      log(`[new-worktree] wire step failed for ${wtPath} (exit ${result.status}). ${fallback}`)
      return { success: false }
    }
    return { success: true }
  } catch (err) {
    log(`[new-worktree] failed to wire Claude Code MCP for ${wtPath} (${err.message}). ${fallback}`)
    return { success: false }
  }
}

/**
 * Copy the main checkout's built `packages/mcp-server/dist` into a fresh worktree BEFORE its first
 * `pnpm install`.
 *
 * That install links every workspace dep's declared `bin`, and @kamiazya/whiteboard-mcp declares
 * `whiteboard -> dist/cli/index.js`. `dist` is gitignored, so a new worktree has none and pnpm
 * prints two ENOENT warnings it can do nothing about. Seeding the directory first removes them,
 * and leaves the worktree able to run the server without a build.
 *
 * Never load-bearing: an absent build or a failed copy is logged and skipped, because a worktree
 * that exists without this is still a working worktree. The copy is a starting point, not a
 * substitute for building — anything editing mcp-server rebuilds anyway.
 *
 * `dist/web-app` is the ONE subtree that argument does not cover, so it is never seeded. It is not
 * tooling the worktree runs: it is the built web app that three browser smokes SERVE as the
 * subject under test (`mcp-read-plane`, `mcp-passkey-promote`, `mcp-daemon-origin`). Seeded, a
 * fresh worktree tests whatever bundle the main checkout last built — from another branch, any
 * number of days old — and says nothing about the tree it is in.
 *
 * Measured: a worktree at pristine `origin/main` failed `smoke:read-plane` 9 of 18 checks, and the
 * same worktree at the same commit passed 37 of 37 after `pnpm --filter @kamiazya/whiteboard-web
 * build`, twice. That cost one investigation of the app (three refuted hypotheses about the
 * membership gate) before anybody suspected the bundle. Each of those smokes already stops with
 * "run `pnpm build`" when the directory is absent, so not seeding it turns a silent wrong answer
 * into that instruction.
 *
 * @returns {boolean} whether a dist was seeded
 */
/**
 * Whether one path inside the main checkout's `dist` is carried into a worktree.
 *
 * Exported for its test: the rule is one line and the reason it exists is the paragraph above
 * `seedBuiltDist`, so what a test can hold is that the built web app is refused and the CLI the
 * seed exists for is not.
 */
export function seedsThisPath(src) {
  return !/(^|[\\/])web-app([\\/]|$)/.test(src)
}

export function seedBuiltDist({ mainRoot, worktreeRoot, existsSync: exists = existsSync, cpSync = nodeCpSync, log = (msg) => console.warn(msg) }) {
  const from = `${mainRoot}/packages/mcp-server/dist`
  if (!exists(from)) return false
  try {
    cpSync(from, `${worktreeRoot}/packages/mcp-server/dist`, {
      recursive: true,
      filter: seedsThisPath,
    })
    return true
  } catch (err) {
    log(`[new-worktree] could not seed the built dist (${err.message}) — pnpm will warn about the unlinkable \`whiteboard\` bin; harmless.`)
    return false
  }
}

function isRunAsScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function main() {
  const [, , nameArg, baseArg] = process.argv
  if (!nameArg) {
    console.error('usage: node .claude/scripts/new-worktree.mjs <name> [baseRef]  (baseRef default: freshly fetched origin/main)')
    process.exit(1)
  }
  const name = nameArg.replace(/[^A-Za-z0-9._-]/g, '-')
  // Default to a freshly fetched origin/main, not HEAD: HEAD depends on which
  // checkout (or nested worktree) the caller happens to be in, which has
  // produced branches silently based on a stale main or on another feature
  // branch. An explicit baseRef still overrides.
  const base = baseArg || 'origin/main'

  // Resolve the MAIN checkout root even when invoked from inside a linked
  // worktree (whose --show-toplevel would nest the new worktree under it).
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const repoRoot = resolve(process.cwd(), commonDir, '..')
  const wtPath = resolve(repoRoot, '.claude/worktrees', name)
  if (existsSync(wtPath)) {
    console.error(`worktree already exists: ${wtPath}`)
    process.exit(1)
  }

  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
  if (!baseArg) run('git', ['-C', repoRoot, 'fetch', 'origin'])
  run('git', ['-C', repoRoot, 'worktree', 'add', wtPath, '-b', name, base])
  // Before the first install: see seedBuiltDist for why pnpm cannot link the `whiteboard` bin
  // otherwise.
  seedBuiltDist({ mainRoot: repoRoot, worktreeRoot: wtPath })
  run('pnpm', ['--dir', wtPath, 'install', '--prefer-offline'])

  // A linked worktree always has a `.git` FILE (not a directory) at its root,
  // so it's never the main checkout — deriveDevPort hashes its path instead
  // of returning the 3099 main-checkout default.
  const devPort = deriveDevPort({ repoRoot: wtPath, isMainCheckout: false, env: process.env })

  console.log(`\nready worktree: ${wtPath}`)
  console.log(`  branch: ${name} (from ${base})`)
  console.log(`  launch a dev-loop with cwd="${wtPath}" (tests run isolated here).`)
  console.log(`  dev daemon port: ${devPort} (pnpm mcp:http:dev in this worktree binds here)`)

  runWireStep({ scriptPath: resolve(__dirname, 'wire-worktree-mcp.mjs'), wtPath })

  console.log(`  cleanup: git worktree remove --force ${wtPath}`)
}

if (isRunAsScript()) {
  main()
}
