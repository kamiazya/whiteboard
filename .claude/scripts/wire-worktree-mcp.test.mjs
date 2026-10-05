#!/usr/bin/env node

// Regression coverage for wire-worktree-mcp.mjs: the cross-package import of
// checkout-kind-lib.mjs (a relative filesystem path, which nothing in the
// module graph otherwise flags on a future move/rename), plus execution-level coverage of the I/O
// entry's decision sequencing via an injectable `main()`.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from './wire-worktree-mcp.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('the relative path wire-worktree-mcp.mjs imports checkout-kind-lib.mjs from resolves and exposes isMainCheckout', async () => {
  const libPath = resolve(__dirname, '../../packages/mcp-server/scripts/dev/checkout-kind-lib.mjs')
  const { isMainCheckout } = await import(libPath)

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
  })

  assert.equal(writeCalls, 0)
  assert.ok(logs.some((line) => /not on PATH/i.test(line)))
})

test('main: absent registration + successful `claude mcp add` + matching post-write read reports "wired"', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  let addSpawns = 0
  let readCalls = 0
  let writtenLine
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: (_cmd, args) => {
      if (args?.includes('add')) {
        addSpawns += 1
        // Real `claude mcp add` writes the entry into ~/.claude.json itself;
        // capture the command line passed after `--` so the post-write
        // readConfig stub below can echo back a registration that matches
        // exactly what was requested.
        writtenLine = args.slice(args.indexOf('--') + 1)
      }
      return fakeSpawnOk()
    },
    readConfig: () => {
      readCalls += 1
      // First read (pre-write classify): absent. Second read (post-write
      // verify): `claude mcp add` succeeded and wrote exactly what was
      // requested.
      if (readCalls === 1) return { projects: {} }
      const [command, ...args] = writtenLine
      return {
        projects: {
          [resolve(repoRoot)]: {
            mcpServers: { whiteboard: { type: 'stdio', command, args, env: {} } },
          },
        },
      }
    },
    writeConfig: () => {
      throw new Error(
        'writeConfig must not be called on the plain-wiring path — only `claude mcp add` writes',
      )
    },
    log: (msg) => logs.push(msg),
  })

  assert.equal(addSpawns, 1)
  assert.equal(readCalls, 2)
  assert.ok(
    logs.some((line) => /^\[wire-worktree-mcp\] wired "whiteboard" -> /.test(line)),
    `expected a "wired" success log, got: ${JSON.stringify(logs)}`,
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
    spawn: (_cmd, args) => {
      if (args?.includes('add')) addSpawned = true
      return fakeSpawnOk()
    },
    readConfig: () => ({
      projects: {
        [resolve(repoRoot)]: {
          mcpServers: {
            whiteboard: { type: 'http', url: 'http://127.0.0.1:9999/mcp', headers: {} },
          },
        },
      },
    }),
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
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
    spawn: (_cmd, args) => {
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
            mcpServers: {
              whiteboard: { type: 'http', url: 'http://127.0.0.1:1111/mcp', headers: {} },
            },
          },
        },
      }
    },
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
  })

  assert.equal(addSpawns, 1)
  assert.ok(logs.some((line) => /does not match|mismatch/i.test(line)))
})

test('main: an already-identical registration is a no-op — no `claude mcp add` spawn, no write', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  let addSpawned = false
  let writeCalls = 0
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: (_cmd, args) => {
      if (args?.includes('add')) addSpawned = true
      return fakeSpawnOk()
    },
    readConfig: () => ({
      projects: {
        [resolve(repoRoot)]: {
          mcpServers: {
            whiteboard: {
              type: 'stdio',
              command: 'node',
              args: [`${repoRoot}/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs`],
              env: {},
            },
          },
        },
      },
    }),
    writeConfig: () => {
      writeCalls += 1
    },
    log: (msg) => logs.push(msg),
  })

  assert.equal(addSpawned, false)
  assert.equal(writeCalls, 0)
  assert.ok(
    logs.some((line) => /already wired/.test(line)),
    JSON.stringify(logs),
  )
})

test('main: a non-zero-exit `claude mcp add` is logged without a post-write verify read', async () => {
  const repoRoot = '/repo/.claude/worktrees/wt-a'
  let readCalls = 0
  const logs = []
  await main({
    argv: [repoRoot],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    spawn: (_cmd, args) => {
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
  })

  assert.ok(writtenConfig, 'expected a config write for the sweep')
  assert.equal(writtenConfig.projects[stalePath].mcpServers.whiteboard, undefined)
  assert.deepEqual(writtenConfig.projects[alivePath].mcpServers.whiteboard, {
    type: 'http',
    url: 'y',
  })
})

const PROXY_SUFFIX = 'packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs'

function stdioEntry(root) {
  return { type: 'stdio', command: 'node', args: [`${root}/${PROXY_SUFFIX}`], env: {} }
}

test("main: with the main checkout's slot empty, `claude mcp add` registers the MAIN checkout's proxy — never a worktree's", async () => {
  const mainRoot = '/repo'
  const worktree = '/repo/.claude/worktrees/wt-a'
  let readCalls = 0
  let addArgs
  const logs = []
  await main({
    argv: [worktree],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    mainCheckoutRootOverride: mainRoot,
    spawn: (_cmd, args) => {
      if (args?.includes('add')) addArgs = args
      return fakeSpawnOk()
    },
    readConfig: () => {
      readCalls += 1
      if (readCalls === 1) return { projects: {} }
      const [command, ...args] = addArgs.slice(addArgs.indexOf('--') + 1)
      return {
        projects: {
          [mainRoot]: { mcpServers: { whiteboard: { type: 'stdio', command, args, env: {} } } },
        },
      }
    },
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
  })

  assert.ok(addArgs, `expected a \`claude mcp add\`, got: ${JSON.stringify(logs)}`)
  const registered = addArgs.slice(addArgs.indexOf('--') + 1)
  assert.deepEqual(registered, ['node', `${mainRoot}/${PROXY_SUFFIX}`])
  assert.ok(
    !registered.some((part) => part.includes('/.claude/worktrees/')),
    JSON.stringify(registered),
  )
  assert.ok(
    logs.some((line) => /^\[wire-worktree-mcp\] wired "whiteboard" -> /.test(line)),
    JSON.stringify(logs),
  )
  assert.ok(!logs.some((line) => /does not match/.test(line)), JSON.stringify(logs))
})

test("main --sweep: drops the main checkout key's entry once the worktree its args name is gone", async () => {
  const mainRoot = resolve('/repo')
  const gone = resolve('/repo/.claude/worktrees/gone')
  let writtenConfig
  const logs = []
  await main({
    argv: ['--sweep'],
    mainCheckoutRootOverride: mainRoot,
    liveWorktreePathsOverride: [mainRoot],
    spawn: () => fakeSpawnOk(),
    readConfig: () => ({
      projects: {
        [mainRoot]: {
          mcpServers: { whiteboard: stdioEntry(gone), other: { type: 'http', url: 'x' } },
        },
      },
    }),
    writeConfig: (config) => {
      writtenConfig = config
    },
    log: (msg) => logs.push(msg),
  })

  assert.ok(writtenConfig, `expected a config write, got: ${JSON.stringify(logs)}`)
  assert.equal(writtenConfig.projects[mainRoot].mcpServers.whiteboard, undefined)
  assert.deepEqual(writtenConfig.projects[mainRoot].mcpServers.other, { type: 'http', url: 'x' })
})

test("main --sweep: keeps the main checkout key's entry while its args name a live worktree or the checkout itself", async () => {
  const mainRoot = resolve('/repo')
  const alive = resolve('/repo/.claude/worktrees/alive')
  for (const root of [alive, mainRoot]) {
    let writes = 0
    await main({
      argv: ['--sweep'],
      mainCheckoutRootOverride: mainRoot,
      liveWorktreePathsOverride: [mainRoot, alive],
      spawn: () => fakeSpawnOk(),
      readConfig: () => ({
        projects: { [mainRoot]: { mcpServers: { whiteboard: stdioEntry(root) } } },
      }),
      writeConfig: () => {
        writes += 1
      },
      log: () => {},
    })
    assert.equal(writes, 0, `entry naming ${root} must survive`)
  }
})

test("main --sweep: leaves a main checkout entry that is not this script's stdio proxy registration untouched", async () => {
  const mainRoot = resolve('/repo')
  let writes = 0
  await main({
    argv: ['--sweep'],
    mainCheckoutRootOverride: mainRoot,
    liveWorktreePathsOverride: [mainRoot],
    spawn: () => fakeSpawnOk(),
    readConfig: () => ({
      projects: {
        [mainRoot]: {
          mcpServers: {
            whiteboard: {
              type: 'stdio',
              command: 'npx',
              args: ['@kamiazya/whiteboard-mcp@latest'],
            },
          },
        },
      },
    }),
    writeConfig: () => {
      writes += 1
    },
    log: () => {},
  })
  assert.equal(writes, 0)
})

test("main --sweep: dropping the main checkout key's entry prints the command that registers the main checkout again", async () => {
  const mainRoot = resolve('/repo')
  const gone = resolve('/repo/.claude/worktrees/gone')
  const logs = []
  await main({
    argv: ['--sweep'],
    mainCheckoutRootOverride: mainRoot,
    liveWorktreePathsOverride: [mainRoot],
    spawn: () => fakeSpawnOk(),
    readConfig: () => ({
      projects: { [mainRoot]: { mcpServers: { whiteboard: stdioEntry(gone) } } },
    }),
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
  })

  const note = logs.find((line) => /no `whiteboard` registration/.test(line))
  assert.ok(note, JSON.stringify(logs))
  assert.ok(
    note.includes(
      `claude mcp add --scope local --transport stdio whiteboard -- node "${join(mainRoot, PROXY_SUFFIX)}"`,
    ),
    note,
  )
})

test('main --sweep: a worktree-keyed removal leaves the main slot alone, so it prints no re-register command', async () => {
  const mainRoot = resolve('/repo')
  const stalePath = resolve('/repo/.claude/worktrees/gone')
  const logs = []
  await main({
    argv: ['--sweep'],
    mainCheckoutRootOverride: mainRoot,
    liveWorktreePathsOverride: [mainRoot],
    spawn: () => fakeSpawnOk(),
    readConfig: () => ({
      projects: { [stalePath]: { mcpServers: { whiteboard: { type: 'http', url: 'x' } } } },
    }),
    writeConfig: () => {},
    log: (msg) => logs.push(msg),
  })

  assert.ok(
    logs.some((line) => /removed stale/.test(line)),
    JSON.stringify(logs),
  )
  assert.ok(!logs.some((line) => /claude mcp add/.test(line)), JSON.stringify(logs))
})

// A worktree removed without the sweep leaves the repository's one slot naming a proxy that no
// longer exists. Wiring the next worktree used to read that slot as "already registered" and say
// so, while every session in the repository started with no whiteboard tools at all.
function wireWithMainSlot({ mainEntry, pathExists }) {
  const mainRoot = resolve('/repo')
  const logs = []
  let addSpawns = 0
  return main({
    argv: [resolve('/repo/.claude/worktrees/wt-a')],
    isMainCheckoutOverride: false,
    claudeCliAvailableOverride: true,
    mainCheckoutRootOverride: mainRoot,
    pathExists,
    spawn: (_cmd, args) => {
      if (args?.includes('add')) addSpawns += 1
      return fakeSpawnOk()
    },
    readConfig: () => ({ projects: { [mainRoot]: { mcpServers: { whiteboard: mainEntry } } } }),
    writeConfig: () => {
      throw new Error('wiring must never rewrite ~/.claude.json itself')
    },
    log: (msg) => logs.push(msg),
  }).then(() => ({ logs, addSpawns, mainRoot }))
}

test("main: a main slot naming a proxy that no longer exists prints the re-register command, not 'already registers'", async () => {
  const gone = resolve('/repo/.claude/worktrees/gone')
  const { logs, addSpawns, mainRoot } = await wireWithMainSlot({
    mainEntry: stdioEntry(gone),
    pathExists: (path) => !path.startsWith(gone),
  })

  assert.equal(addSpawns, 0, 'the slot is filled, so an add would fail with "already exists"')
  assert.ok(!logs.some((line) => /already registers/.test(line)), JSON.stringify(logs))
  const note = logs.find((line) => line.includes(join(gone, PROXY_SUFFIX)))
  assert.ok(note, JSON.stringify(logs))
  assert.ok(note.includes('claude mcp remove whiteboard -s local'), note)
  assert.ok(
    note.includes(
      `claude mcp add --scope local --transport stdio whiteboard -- node "${join(mainRoot, PROXY_SUFFIX)}"`,
    ),
    note,
  )
})

test("main: a main slot whose proxy exists is still left alone as 'already registers'", async () => {
  const { logs, addSpawns } = await wireWithMainSlot({
    mainEntry: stdioEntry(resolve('/repo')),
    pathExists: () => true,
  })

  assert.equal(addSpawns, 0)
  assert.ok(
    logs.some((line) => /already registers/.test(line)),
    JSON.stringify(logs),
  )
  assert.ok(!logs.some((line) => /claude mcp remove/.test(line)), JSON.stringify(logs))
})

// Both exit before any config or git access, but HOME is scratch anyway: this suite must never be
// able to reach the developer's real ~/.claude.json.
test('the CLI answers --help, and refuses a mistyped option or a surplus argument, before wiring or sweeping anything', () => {
  const home = mkdtempSync(join(tmpdir(), 'wire-worktree-flags-'))
  try {
    for (const args of [['--help'], ['--sweeep'], ['--bogus'], ['a', 'b']]) {
      const result = spawnSync('node', [join(__dirname, 'wire-worktree-mcp.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      })
      assert.equal(result.status, args[0] === '--help' ? 0 : 2, JSON.stringify(args))
      assert.match(
        `${result.stdout}${result.stderr}`,
        /usage: wire-worktree-mcp/,
        JSON.stringify(args),
      )
      assert.doesNotMatch(result.stdout, /wired|sweep:/, JSON.stringify(args))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
