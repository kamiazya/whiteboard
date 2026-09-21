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

// --- pre-seeding the built dist ---
import { seedBuiltDist, seedsThisPath } from './new-worktree.mjs'

// `pnpm install` links every workspace dep's declared `bin`. @kamiazya/whiteboard-mcp declares
// `whiteboard -> dist/cli/index.js`, and `dist` is gitignored, so a fresh worktree's FIRST install
// cannot create the symlink and pnpm prints two ENOENT warnings. Verified: seeding dist before
// that first install removes them. Moving the bin path was rejected — `dist/cli/index.js` is
// pinned by prepend-cli-shebang, check-release-artifacts and three distribution smokes, and none
// of that release surface should move for an install-time warning.
test('seeds the built dist when the main checkout has one', () => {
  const copies = []
  const ok = seedBuiltDist({
    mainRoot: '/repo',
    worktreeRoot: '/wt',
    existsSync: (p) => p === '/repo/packages/mcp-server/dist',
    cpSync: (from, to, options) => copies.push([from, to, options]),
    log: () => {},
  })
  assert.equal(ok, true)
  assert.equal(copies.length, 1)
  assert.deepEqual(copies[0].slice(0, 2), [
    '/repo/packages/mcp-server/dist',
    '/wt/packages/mcp-server/dist',
  ])
  // The copy is filtered, and by the exported rule rather than by a second
  // copy of it — see the next test for what that rule refuses.
  assert.equal(copies[0][2].recursive, true)
  assert.equal(copies[0][2].filter, seedsThisPath)
})

// `dist/web-app` is the built web app three browser smokes SERVE as the
// subject under test, so seeding it makes a fresh worktree test whatever the
// main checkout last built. Measured once: 9 of 18 read-plane checks failed
// on pristine main until the app was rebuilt in the worktree, and 37 of 37
// passed after.
test('the seed carries the CLI it exists for and never the built web app', () => {
  assert.equal(seedsThisPath('/repo/packages/mcp-server/dist/cli/index.js'), true)
  assert.equal(seedsThisPath('/repo/packages/mcp-server/dist/widget/entry.js'), true)
  assert.equal(seedsThisPath('/repo/packages/mcp-server/dist/web-app'), false)
  assert.equal(seedsThisPath('/repo/packages/mcp-server/dist/web-app/index.html'), false)
  assert.equal(seedsThisPath('/repo/packages/mcp-server/dist/web-app/assets/App-1.js'), false)
  // A path that merely CONTAINS the word is not the directory.
  assert.equal(seedsThisPath('/repo/packages/mcp-server/dist/cli/web-apps.js'), true)
})

test('skips silently when the main checkout has no build yet', () => {
  const copies = []
  const ok = seedBuiltDist({
    mainRoot: '/repo',
    worktreeRoot: '/wt',
    existsSync: () => false,
    cpSync: (from, to) => copies.push([from, to]),
    log: () => {},
  })
  assert.equal(ok, false)
  assert.deepEqual(copies, [])
})

// Seeding is an optimisation, never a reason a worktree fails to be created.
test('a copy failure is reported and swallowed', () => {
  const logs = []
  const ok = seedBuiltDist({
    mainRoot: '/repo',
    worktreeRoot: '/wt',
    existsSync: () => true,
    cpSync: () => {
      throw new Error('disk full')
    },
    log: (m) => logs.push(m),
  })
  assert.equal(ok, false)
  assert.ok(logs.some((m) => m.includes('disk full')))
})
