// Subprocess-level tests of the SessionStart hook entrypoint. Runs the real
// ensure-http-dev-daemon.mjs as a child process against a PATH-shimmed
// `pnpm` (never a real build) plus a fake daemon on a socket, so
// the wait-for-ready behavior is exercised the same way a client's session
// start actually does: wait for the hook process to exit, not for a unit
// under test to return a promise.
//
// No .cmd counterpart exists for the shim, so this suite only runs on POSIX.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeMcpResponder } from './test-utils/fake-mcp-daemon.mjs'
import { resolveRepoRootFromGit } from './with-dev-data-dir-lib.mjs'

const REPO_ROOT = resolveRepoRootFromGit(resolve(import.meta.dirname))
const HOOK_SCRIPT_PATH = resolve(import.meta.dirname, 'ensure-http-dev-daemon.mjs')
const SHIM_ENTRY_PATH = resolve(import.meta.dirname, 'test-utils/fake-pnpm-shim.mjs')
const LOG_PATH_SUFFIX = 'tmp/logs/mcp-http-dev.log'

/** A TCP listener that only counts who connects to it. */
async function countingTcpListener(): Promise<{
  port: number
  connections: () => number
  server: Server
}> {
  let count = 0
  const server = createServer((socket) => {
    count += 1
    socket.destroy()
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, connections: () => count, server }
}

/**
 * Writes a POSIX `pnpm` wrapper into a fresh temp dir that execs node
 * directly against fake-pnpm-shim.mjs, and returns that dir for prepending
 * onto the spawned hook's PATH.
 */
function writePnpmShimDir(): string {
  const shimDir = mkdtempSync(join(tmpdir(), 'ensure-http-dev-daemon-shim-'))
  const shimPath = join(shimDir, 'pnpm')
  writeFileSync(shimPath, `#!/bin/sh\nexec node "${SHIM_ENTRY_PATH}" "$@"\n`)
  chmodSync(shimPath, 0o755)
  return shimDir
}

function runHook(env: NodeJS.ProcessEnv): Promise<{
  exitCode: number | null
  exitedAt: number
  stderr: string
  stdout: string
}> {
  return new Promise((resolveRun) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [HOOK_SCRIPT_PATH, '--quiet'],
      { cwd: REPO_ROOT, env },
    )
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    // 'close', not 'exit': 'exit' fires when the process terminates, while
    // its stdio may still have buffered data to deliver. Resolving there
    // discards whatever the hook printed on its way out — which is how a
    // failing run once reported "exit 1" with an empty stderr, throwing away
    // the only evidence of why it failed. 'close' fires after every stdio
    // stream has ended, so the captured output is complete.
    child.once('close', (exitCode) => {
      resolveRun({ exitCode, exitedAt: Date.now(), stderr, stdout })
    })
  })
}

function killQuietly(pid: number | undefined) {
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already dead */
  }
}

const itPosix = it.skipIf(process.platform === 'win32')

function readSentinel<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

describe('ensure-http-dev-daemon.mjs (subprocess)', () => {
  const cleanupPids: number[] = []
  // Every hook run's spawned daemons are killed in afterEach, not at the end of
  // the test body: an assertion that fails first (a readiness timeout under
  // load) would otherwise skip the kill and leave the daemon running.
  const cleanupSentinelDirs: string[] = []
  const cleanupDirs: string[] = []
  let cleanupResponder: (() => Promise<void>) | undefined
  let cleanupServer: Server | undefined

  afterEach(async () => {
    for (const pid of cleanupPids.splice(0)) killQuietly(pid)
    for (const dir of cleanupSentinelDirs.splice(0)) killAllSpawnedPids(dir)
    if (cleanupResponder) {
      await cleanupResponder()
      cleanupResponder = undefined
    }
    if (cleanupServer) {
      const server = cleanupServer
      cleanupServer = undefined
      await new Promise<void>((closed) => server.close(() => closed()))
    }
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Makes a temp data dir and a PATH shim dir (both registered for cleanup),
   * and returns the env every hook run shares. Per-case behavior is layered
   * on by spreading extra FAKE_PNPM_* / WHITEBOARD_DEV_READY_TIMEOUT_MS
   * entries over `env`.
   */
  async function prepareHookRun(): Promise<{
    token: string
    dataDir: string
    invokedSentinelPath: string
    invokedSentinelDir: string
    lockPath: string
    countSpawns: () => number
    env: NodeJS.ProcessEnv
  }> {
    const token = randomUUID()
    const dataDir = mkdtempSync(join(tmpdir(), 'ensure-http-dev-daemon-data-'))
    const shimDir = writePnpmShimDir()
    cleanupDirs.push(dataDir, shimDir)
    const invokedSentinelPath = join(dataDir, 'invoked-sentinel.json')
    const invokedSentinelDir = join(dataDir, 'invoked-sentinels')
    cleanupSentinelDirs.push(invokedSentinelDir)
    const lockPath = join(dataDir, 'dev-daemon-spawn.lock')
    const countSpawns = () =>
      existsSync(invokedSentinelDir) ? readdirSync(invokedSentinelDir).length : 0

    return {
      token,
      dataDir,
      invokedSentinelPath,
      invokedSentinelDir,
      lockPath,
      countSpawns,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        WHITEBOARD_TOKEN: token,
        WHITEBOARD_DATA_DIR: dataDir,
        FAKE_PNPM_INVOKED_SENTINEL: invokedSentinelPath,
        FAKE_PNPM_INVOKED_SENTINEL_DIR: invokedSentinelDir,
      },
    }
  }

  function killAllSpawnedPids(invokedSentinelDir: string) {
    if (!existsSync(invokedSentinelDir)) return
    for (const file of readdirSync(invokedSentinelDir)) {
      const { pid } = readSentinel<{ pid: number }>(join(invokedSentinelDir, file))
      killQuietly(pid)
    }
  }

  itPosix(
    'does not exit until the daemon it spawned actually answers MCP (happens-before, not a timing threshold)',
    async () => {
      const { dataDir, invokedSentinelPath, env } = await prepareHookRun()
      const bindSentinelPath = join(dataDir, 'bind-sentinel.json')

      const { exitCode, exitedAt, stderr } = await runHook({
        ...env,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '8000',
        FAKE_PNPM_BIND_DELAY_MS: '1200',
        FAKE_PNPM_BIND_SENTINEL: bindSentinelPath,
      })

      expect(exitCode, `hook stderr:\n${stderr}`).toBe(0)
      const { boundAt } = readSentinel<{ boundAt: number }>(bindSentinelPath)
      // The headline invariant: the hook's exit is never earlier than the
      // daemon's bind. A fire-and-forget hook would exit long before the
      // 1.2s bind delay elapses and this would fail.
      expect(exitedAt).toBeGreaterThanOrEqual(boundAt)

      // The hook unref's the spawned daemon rather than killing it — clean
      // up the still-running fake daemon so it doesn't leak past the test.
      cleanupPids.push(readSentinel<{ pid: number }>(invokedSentinelPath).pid)
    },
  )

  itPosix(
    'terminates within the bound and fails loudly when the daemon never answers',
    async () => {
      const { invokedSentinelPath, env } = await prepareHookRun()

      const startedAt = Date.now()
      const { exitCode, stderr } = await runHook({
        ...env,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '800',
        FAKE_PNPM_NEVER_BIND: '1',
      })
      const elapsedMs = Date.now() - startedAt

      // Well under the mcp-node project's 10s testTimeout — proves the
      // hook terminates on its own instead of hanging.
      expect(elapsedMs).toBeLessThan(6_000)
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain(LOG_PATH_SUFFIX)
      expect(stderr).toContain('MCP tools will be unavailable')

      cleanupPids.push(readSentinel<{ pid: number }>(invokedSentinelPath).pid)
    },
  )

  itPosix(
    'is a no-op when the daemon its record names answers on the socket, and never connects to the port',
    async () => {
      const { token, dataDir, invokedSentinelPath, lockPath, env } = await prepareHookRun()

      const socketPath = join(dataDir, 'daemon.sock')
      const responder = await startFakeMcpResponder({ socketPath, token })
      cleanupResponder = responder.close
      writeFileSync(
        join(dataDir, 'daemon.json'),
        JSON.stringify({ pid: process.pid, token, socketPath }),
      )
      // Something on the port the daemon was spawned with: the hook must not
      // go there to decide anything.
      const tcp = await countingTcpListener()
      cleanupServer = tcp.server

      const { exitCode, stderr } = await runHook({ ...env, WHITEBOARD_DEV_PORT: String(tcp.port) })

      expect(exitCode, `hook stderr:\n${stderr}`).toBe(0)
      expect(tcp.connections()).toBe(0)
      expect(() => readFileSync(invokedSentinelPath, 'utf8')).toThrow()
      // The fast path must never touch the lock: no spawn decision was made.
      expect(existsSync(lockPath)).toBe(false)
    },
  )

  itPosix(
    'spawns a daemon when the record left behind names a socket nothing answers on',
    async () => {
      const { token, dataDir, countSpawns, env } = await prepareHookRun()
      writeFileSync(
        join(dataDir, 'daemon.json'),
        JSON.stringify({ pid: 999_999, token, socketPath: join(dataDir, 'gone.sock') }),
      )

      const { exitCode, stderr } = await runHook({
        ...env,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '8000',
      })

      expect(exitCode, `hook stderr:\n${stderr}`).toBe(0)
      expect(countSpawns()).toBe(1)
    },
  )

  itPosix('refuses a running daemon that was started with a different token', async () => {
    const { token, dataDir, countSpawns, env } = await prepareHookRun()
    const socketPath = join(dataDir, 'daemon.sock')
    const responder = await startFakeMcpResponder({ socketPath, token: 'another-token' })
    cleanupResponder = responder.close
    writeFileSync(
      join(dataDir, 'daemon.json'),
      JSON.stringify({ pid: process.pid, token: 'another-token', socketPath }),
    )

    const { exitCode, stderr } = await runHook(env)

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('different token')
    expect(stderr).not.toContain('another-token')
    expect(stderr).not.toContain(token)
    expect(countSpawns()).toBe(0)
  })

  itPosix(
    'two concurrent hooks with no daemon up produce exactly one spawn, both exit 0',
    async () => {
      const { countSpawns, env } = await prepareHookRun()

      const runEnv = {
        ...env,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '8000',
        FAKE_PNPM_BIND_DELAY_MS: '500',
      }

      const [first, second] = await Promise.all([runHook(runEnv), runHook(runEnv)])

      expect(
        first.exitCode,
        `hook 1 stderr:\n${first.stderr}\nhook 1 stdout:\n${first.stdout}`,
      ).toBe(0)
      expect(
        second.exitCode,
        `hook 2 stderr:\n${second.stderr}\nhook 2 stdout:\n${second.stdout}`,
      ).toBe(0)
      // The discriminating assertion: exactly one process was ever spawned.
      // Without the lock, both hooks find no daemon and both spawn.
      expect(countSpawns()).toBe(1)
    },
  )

  itPosix(
    'writes the reason to the daemon log when the spawned dev server cannot bind',
    async () => {
      const { env } = await prepareHookRun()
      const logPath = join(REPO_ROOT, LOG_PATH_SUFFIX)

      // The failure is INJECTED into the spawned process rather than
      // manufactured by racing the OS for the port. What is under test is
      // the hook: when the dev server cannot bind, does it say so and point
      // at the log? Producing a real EADDRINUSE meant squatting the port
      // inside the window between `reserveFreePort()`'s close and the
      // delayed listen(), timed by a 250ms sleep against a 600ms delay —
      // and under load the sleep overran, the squat landed after the bind,
      // and the server started normally. The assertion then read
      // `expected '[ensure-http-dev-daemon] http://127.0…' to contain
      // 'tmp/logs/mcp-http-dev.log'`, which looks like a product defect and
      // is really the test failing to build its own premise. Three pre-push
      // runs died on it while three isolated runs passed.
      // The readiness timeout still has to be short: the spawned process
      // dies immediately, but the hook waits out its own budget before
      // giving up, and the default outlives this test's.
      const hookRun = runHook({
        ...env,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '3000',
        FAKE_PNPM_BIND_FAILS: '1',
      })

      const { exitCode, stderr } = await hookRun
      expect(exitCode).not.toBe(0)
      // The hook points at the log; the log must actually name the cause,
      // or "spawned process exited with code 1" is all anyone ever sees.
      expect(stderr).toContain(LOG_PATH_SUFFIX)
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
      expect(log).toContain('EADDRINUSE')
    },
  )

  itPosix(
    'a stale lock (dead recorded pid) does not block a spawn, and the hook still terminates within its bound',
    async () => {
      const { lockPath, countSpawns, env } = await prepareHookRun()

      // A definitely-dead pid: reserve one by starting and killing a
      // throwaway child, so this isn't a real live pid on the test machine.
      const throwaway = spawn(process.execPath, ['-e', ''])
      const deadPid = await new Promise<number>((resolvePid) => {
        throwaway.once('exit', () => resolvePid(throwaway.pid as number))
      })

      writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }))

      const startedAt = Date.now()
      const { exitCode, stderr } = await runHook({
        ...env,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '8000',
      })
      const elapsedMs = Date.now() - startedAt

      expect(exitCode, `hook stderr:\n${stderr}`).toBe(0)
      expect(elapsedMs).toBeLessThan(6_000)
      expect(countSpawns()).toBe(1)
    },
  )
})
