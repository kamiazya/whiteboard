#!/usr/bin/env node
// Regression coverage for wire-worktree-mcp.mjs: the cross-package import of
// dev-port-lib.mjs (mirrors new-worktree.test.mjs's guard for the same
// relative filesystem path, which nothing in the module graph otherwise
// flags on a future move/rename), plus execution-level coverage of the I/O
// entry's decision sequencing via an injectable `main()`.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from './wire-worktree-mcp.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('the relative path wire-worktree-mcp.mjs imports dev-port-lib.mjs from resolves and exposes isMainCheckout', async () => {
  const devPortLibPath = resolve(__dirname, '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs')
  const { isMainCheckout } = await import(devPortLibPath)

  assert.equal(typeof isMainCheckout, 'function')
})

function fakeSpawnOk() {
  return { status: 0, stdout: '', stderr: '', error: undefined }
}

test('main: short-circuits for the main checkout — no spawn, no write', async () => {
  let spawnCalls = 0
  let writeCalls = 0
  const logs = []
  await main({
    argv: ['/repo'],
    isMainCheckoutOverride: true,
    spawn: () => {
      spawnCalls += 1
      return fakeSpawnOk()
    },
    readConfig: () => ({ projects: {} }),
    writeConfig: () => {
      writeCalls += 1
    },
    log: (msg) => logs.push(msg),
  })

  assert.equal(spawnCalls, 0)
  assert.equal(writeCalls, 0)
  assert.ok(logs.some((line) => /main checkout/i.test(line)))
})

test('main: missing `claude` CLI skips wiring without touching config', async () => {
  let writeCalls = 0
  const logs = []
  await main({
    argv: ['/repo/.claude/worktrees/wt-a'],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: false,
    spawn: () => {
      throw new Error('spawn must not be called when the CLI is unavailable')
    },
    readConfig: () => ({ projects: {} }),
    writeConfig: () => {
      writeCalls += 1
    },
    log: (msg) => logs.push(msg),
    env: {},
  })

  assert.equal(writeCalls, 0)
  assert.ok(logs.some((line) => /not on PATH/i.test(line)))
})

test('main: a conflicting existing registration is left untouched — no `claude mcp add` spawn', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  let addSpawned = false
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: (cmd, args) => {
      if (args?.includes('add')) addSpawned = true
      return fakeSpawnOk()
    },
    readConfig: () => ({
      projects: {
        [resolve(repoRoot)]: {
          mcpServers: { whiteboard: { type: 'http', url: 'http://127.0.0.1:9999/mcp', headers: {} } },
        },
      },
    }),
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
    env: {},
  })

  assert.equal(addSpawned, false)
  assert.ok(logs.some((line) => /conflicting/i.test(line)))
})

test('main: a post-write mismatch is reported without retrying the write', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  let addSpawns = 0
  let readCalls = 0
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: (cmd, args) => {
      if (args?.includes('add')) addSpawns += 1
      return fakeSpawnOk()
    },
    readConfig: () => {
      readCalls += 1
      // First read (pre-write classify): absent. Second read (post-write
      // verify): a concurrent writer raced us to a different URL.
      if (readCalls === 1) return { projects: {} }
      return {
        projects: {
          [resolve(repoRoot)]: {
            mcpServers: { whiteboard: { type: 'http', url: 'http://127.0.0.1:1111/mcp', headers: {} } },
          },
        },
      }
    },
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
    env: {},
  })

  assert.equal(addSpawns, 1)
  assert.ok(logs.some((line) => /does not match|mismatch/i.test(line)))
})

test('main --sweep: removes stale entries via a config write, keeps live entries, tolerates ENOENT-deleted paths', async () => {
  const mainRoot = '/repo'
  const stalePath = resolve('/repo/.claude/worktrees/gone')
  const alivePath = resolve('/repo/.claude/worktrees/alive')
  let writtenConfig
  await main({
    argv: ['--sweep'],
    mainCheckoutRootOverride: mainRoot,
    liveWorktreePathsOverride: [alivePath],
    spawn: () => fakeSpawnOk(),
    readConfig: () => ({
      projects: {
        [stalePath]: { mcpServers: { whiteboard: { type: 'http', url: 'x' } } },
        [alivePath]: { mcpServers: { whiteboard: { type: 'http', url: 'y' } } },
      },
    }),
    writeConfig: (config) => {
      writtenConfig = config
    },
    log: () => {},
    env: {},
  })

  assert.ok(writtenConfig, 'expected a config write for the sweep')
  assert.equal(writtenConfig.projects[stalePath].mcpServers.whiteboard, undefined)
  assert.deepEqual(writtenConfig.projects[alivePath].mcpServers.whiteboard, { type: 'http', url: 'y' })
})
