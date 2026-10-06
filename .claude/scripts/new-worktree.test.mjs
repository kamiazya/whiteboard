#!/usr/bin/env node

// Regression coverage for new-worktree.mjs's wire step.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isolatedGitEnv } from './git-test-utils.mjs'
import { runWireStep } from './new-worktree.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'new-worktree.mjs')

test('runWireStep: worktree setup completes (does not throw) even when the wire script exits nonzero', () => {
  const logs = []
  const result = runWireStep({
    scriptPath: '/does/not/matter.mjs',
    wtPath: '/repo/.claude/worktrees/wt-a',
    spawn: () => ({ status: 1, error: undefined, stdout: '', stderr: 'boom' }),
    log: (msg) => logs.push(msg),
  })

  assert.equal(result.success, false)
  assert.ok(logs.some((line) => /wire.*fail|failed to wire/i.test(line)))
  assert.ok(
    logs.some((line) => /wire-worktree-mcp\.mjs/.test(line)),
    'must point at the manual wiring fallback',
  )
})

test('runWireStep: worktree setup completes (does not throw) even when spawning the wire script itself throws (e.g. node missing)', () => {
  const logs = []
  const result = runWireStep({
    scriptPath: '/does/not/matter.mjs',
    wtPath: '/repo/.claude/worktrees/wt-a',
    spawn: () => {
      throw new Error('ENOENT: node not found')
    },
    log: (msg) => logs.push(msg),
  })

  assert.equal(result.success, false)
  assert.ok(logs.some((line) => /wire.*fail|failed to wire/i.test(line)))
})

test('runWireStep: reports success when the wire script exits zero', () => {
  const result = runWireStep({
    scriptPath: '/does/not/matter.mjs',
    wtPath: '/repo/.claude/worktrees/wt-a',
    spawn: () => ({ status: 0, error: undefined, stdout: '', stderr: '' }),
    log: () => {},
  })

  assert.equal(result.success, true)
})

// A worktree starts with NO `packages/mcp-server/dist`, never a copy of the main checkout's.
// A copy is whatever the main checkout last built — another commit, any number of days old — and
// every dist-based check in the worktree (`pnpm mcp:http`, the packaged distribution smokes) runs
// it without a word. Measured: a copy missing the source's two newest migrations made
// `pnpm mcp:http` refuse the worktree's own `.dev-data`, advising an upgrade to a release that did
// not ship them either. With no dist, each of those checks says "run `pnpm build`" instead.
//
// The copy existed to quiet pnpm's ENOENT warning for the unlinkable `whiteboard` bin
// (`dist/cli/index.js`). Measured since under pnpm 11, a fresh worktree's first install with no
// dist at all prints no such warning: no workspace package depends on @kamiazya/whiteboard-mcp,
// so nothing links its bin. If that warning returns, a placeholder file at that one path quiets it
// without handing the worktree a stale build.
test('creating a worktree copies no build into it', () => {
  const source = readFileSync(scriptPath, 'utf-8')
  assert.doesNotMatch(source, /cpSync|copyFileSync/)
  assert.doesNotMatch(source, /mcp-server\/dist/)
})

// An unrecognised option must never become a branch name or a base ref: `--help` is a question,
// and `foo --bogus` used to ask git for a base ref called `--bogus`.
test('--help, an unknown option and a missing name print usage and create no worktree or branch', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'new-worktree-flags-'))
  const env = isolatedGitEnv()
  try {
    execFileSync('git', ['init', '--quiet', scratch], { env })
    for (const args of [
      ['--help'],
      ['--bogus'],
      ['--dry-run'],
      ['foo', '--bogus'],
      ['foo', 'main', 'extra'],
      [],
    ]) {
      const result = spawnSync('node', [scriptPath, ...args], {
        cwd: scratch,
        env,
        encoding: 'utf-8',
        timeout: 20_000,
      })
      const label = JSON.stringify(args)
      assert.equal(
        result.status,
        args[0] === '--help' ? 0 : 2,
        `${label}: ${result.stdout}${result.stderr}`,
      )
      assert.match(`${result.stdout}${result.stderr}`, /usage: .*new-worktree/, label)
      assert.equal(
        existsSync(join(scratch, '.claude', 'worktrees')),
        false,
        `${label} created a worktree directory`,
      )
      assert.equal(
        execFileSync('git', ['branch', '--list'], { cwd: scratch, env, encoding: 'utf-8' }).trim(),
        '',
        `${label} created a branch`,
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
