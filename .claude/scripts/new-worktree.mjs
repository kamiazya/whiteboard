#!/usr/bin/env node
// Local AI-dev-flow helper (lives under .claude/ = gitignored, like workflows/agents/skills).
// Create a ready-to-develop git worktree: branch off a base ref, then `pnpm install`
// (warm pnpm store ~6s) so tests/typecheck run isolated inside it. This is what makes
// PARALLEL dev-loops possible — each runs in its own worktree, so none contends on the
// main working tree. The integrator launches a dev-loop with cwd=<this path>, and
// reconciles the branches before folding.
//
//   node .claude/scripts/new-worktree.mjs <name> [baseRef]      (baseRef default: HEAD)
//
// Remove when done: git worktree remove --force .claude/worktrees/<name>
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
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
    console.error('usage: node .claude/scripts/new-worktree.mjs <name> [baseRef]  (baseRef default: HEAD)')
    process.exit(1)
  }
  const name = nameArg.replace(/[^A-Za-z0-9._-]/g, '-')
  const base = baseArg || 'HEAD'

  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const wtPath = resolve(repoRoot, '.claude/worktrees', name)
  if (existsSync(wtPath)) {
    console.error(`worktree already exists: ${wtPath}`)
    process.exit(1)
  }

  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
  run('git', ['-C', repoRoot, 'worktree', 'add', wtPath, '-b', name, base])
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
