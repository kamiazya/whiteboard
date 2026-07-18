#!/usr/bin/env node
// Regression coverage for new-worktree.mjs's cross-package import of
// dev-port-lib.mjs. That import reaches into packages/mcp-server's internal
// scripts/dev/ directory via a relative filesystem path rather than a
// declared package dependency/export, so nothing in the module graph flags
// a future move/rename of that file — this test is what turns that failure
// mode from "silently wrong at runtime" into "loud in CI".
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWireStep } from './new-worktree.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('the relative path new-worktree.mjs imports dev-port-lib.mjs from resolves and exposes deriveDevPort', async () => {
  const devPortLibPath = resolve(__dirname, '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs')
  const { deriveDevPort } = await import(devPortLibPath)

  assert.equal(typeof deriveDevPort, 'function')
  assert.equal(
    deriveDevPort({ repoRoot: '/repo', isMainCheckout: true, env: {} }),
    3099,
    'sanity-checks the actual imported function still behaves as new-worktree.mjs expects',
  )
})

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
  assert.ok(logs.some((line) => /wire-worktree-mcp\.mjs/.test(line)), 'must point at the manual wiring fallback')
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
