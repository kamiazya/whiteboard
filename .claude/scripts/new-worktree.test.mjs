#!/usr/bin/env node

// Regression coverage for new-worktree.mjs's wire step.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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

// --- pre-seeding the built dist ---
import { seedBuiltDist, seedsThisPath } from './new-worktree.mjs'

// `dist` is gitignored, so a fresh worktree has no built server; the copy lets it run one before
// its first build. The path stays `dist/cli/index.js`: prepend-cli-shebang, check-release-artifacts
// and three distribution smokes pin it.
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

// An unrecognised option must never become a branch name or a base ref: `--help` is a question,
// and `foo --bogus` used to ask git for a base ref called `--bogus`.
test('--help, an unknown option and a missing name print usage and create no worktree or branch', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'new-worktree-flags-'))
  try {
    execFileSync('git', ['init', '--quiet', scratch])
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
        execFileSync('git', ['branch', '--list'], { cwd: scratch, encoding: 'utf-8' }).trim(),
        '',
        `${label} created a branch`,
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
