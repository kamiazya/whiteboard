#!/usr/bin/env node
// Create a ready-to-develop git worktree: branch off a base ref, then `pnpm install`
// (warm pnpm store ~6s) so tests/typecheck run isolated inside it. This is what makes
// PARALLEL dev-loops possible — each runs in its own worktree, so none contends on the
// main working tree. The integrator launches a dev-loop with cwd=<this path>, and
// reconciles the branches before folding.
//
//   node tools/new-worktree.mjs <name> [baseRef]      (baseRef default: HEAD)
//   pnpm worktree:new <name> [baseRef]
//
// Remove when done: git worktree remove --force .claude/worktrees/<name>
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , nameArg, baseArg] = process.argv
if (!nameArg) {
  console.error('usage: node tools/new-worktree.mjs <name> [baseRef]  (baseRef default: HEAD)')
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

console.log(`\nready worktree: ${wtPath}`)
console.log(`  branch: ${name} (from ${base})`)
console.log(`  launch a dev-loop with cwd="${wtPath}" (tests run isolated here).`)
console.log(`  cleanup: git worktree remove --force ${wtPath}`)
