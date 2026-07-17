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

test('main: absent registration + successful `claude mcp add` + matching post-write read reports "wired"', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  let addSpawns = 0
  let readCalls = 0
  let writtenUrl
  let writtenAuthHeader
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: (cmd, args) => {
      if (args?.includes('add')) {
        addSpawns += 1
        // Real `claude mcp add` writes the entry into ~/.claude.json itself;
        // capture the url/header argv passed here so the post-write
        // readConfig stub below can echo back a registration that matches
        // exactly what was requested.
        writtenUrl = args[5]
        const headerIndex = args.indexOf('--header')
        writtenAuthHeader = args[headerIndex + 1]
      }
      return fakeSpawnOk()
    },
    readConfig: () => {
      readCalls += 1
      // First read (pre-write classify): absent. Second read (post-write
      // verify): `claude mcp add` succeeded and wrote exactly what was
      // requested.
      if (readCalls === 1) return { projects: {} }
      const [headerName, headerValue] = writtenAuthHeader.split(': ')
      return {
        projects: {
          [resolve(repoRoot)]: {
            mcpServers: { whiteboard: { type: 'http', url: writtenUrl, headers: { [headerName]: headerValue } } },
          },
        },
      }
    },
    writeConfig: () => {
      throw new Error('writeConfig must not be called on the plain-wiring path — only `claude mcp add` writes')
    },
    log: (msg) => logs.push(msg),
    env: {},
  })

  assert.equal(addSpawns, 1)
  assert.equal(readCalls, 2)
  assert.ok(logs.some((line) => /^\[wire-worktree-mcp\] wired "whiteboard" -> /.test(line)), `expected a "wired" success log, got: ${JSON.stringify(logs)}`)
})

test('main: WHITEBOARD_DEV_PORT set in the calling shell logs the override warning before wiring proceeds', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: () => fakeSpawnOk(),
    readConfig: () => ({ projects: {} }),
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
    env: { WHITEBOARD_DEV_PORT: '9999' },
  })

  assert.ok(
    logs.some((line) => /WHITEBOARD_DEV_PORT is set in this shell but is ignored for registration/.test(line)),
    `expected the override warning to be logged, got: ${JSON.stringify(logs)}`,
  )
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

test('main: an already-identical registration is a no-op — no `claude mcp add` spawn, no write', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  const desiredUrl = 'http://127.0.0.1:3457/mcp'
  let addSpawned = false
  let writeCalls = 0
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
          mcpServers: {
            whiteboard: {
              type: 'http',
              url: desiredUrl,
              headers: { Authorization: 'Bearer whiteboard-dev' },
            },
          },
        },
      },
    }),
    writeConfig: () => {
      writeCalls += 1
    },
    log: (msg) => logs.push(msg),
    env: {},
  })

  // Only asserting the no-op behavior here, not the exact desired port —
  // classifyExistingConfig itself is unit-tested for exact matching.
  assert.equal(addSpawned, false)
  assert.equal(writeCalls, 0)
})

test('main: a non-zero-exit `claude mcp add` is logged (redacted) without a post-write verify read', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  let readCalls = 0
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: (cmd, args) => {
      if (args?.includes('add')) {
        return { status: 1, stdout: '', stderr: 'boom: unauthorized', error: undefined }
      }
      return fakeSpawnOk()
    },
    readConfig: () => {
      readCalls += 1
      return { projects: {} }
    },
    writeConfig: () => {
      throw new Error('writeConfig must not be called on this path')
    },
    log: (msg) => logs.push(msg),
    env: {},
  })

  assert.equal(readCalls, 1, 'must not re-read config for a post-write verify after a failed add')
  assert.ok(logs.some((line) => /failed \(exit 1\)/.test(line)))
  assert.ok(logs.some((line) => /boom: unauthorized/.test(line)))
})

test('main --sweep: no ~/.claude.json projects found is a no-op — no write', async () => {
  let writeCalls = 0
  const logs = []
  await main({
    argv: ['--sweep'],
    mainCheckoutRootOverride: '/repo',
    liveWorktreePathsOverride: [],
    spawn: () => fakeSpawnOk(),
    readConfig: () => ({}),
    writeConfig: () => {
      writeCalls += 1
    },
    log: (msg) => logs.push(msg),
    env: {},
  })

  assert.equal(writeCalls, 0)
  assert.ok(logs.some((line) => /no ~\/\.claude\.json projects found/i.test(line)))
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
