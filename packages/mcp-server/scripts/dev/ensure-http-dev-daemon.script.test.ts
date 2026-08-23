// Subprocess-level tests of the SessionStart hook entrypoint. Runs the real
// ensure-http-dev-daemon.mjs as a child process against a PATH-shimmed
// `pnpm` (never a real build) plus a fake authenticated MCP responder, so
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
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeMcpResponder } from './test-utils/fake-mcp-daemon.mjs'
import { resolveRepoRootFromGit } from './with-dev-data-dir-lib.mjs'

const REPO_ROOT = resolveRepoRootFromGit(resolve(import.meta.dirname))
const HOOK_SCRIPT_PATH = resolve(import.meta.dirname, 'ensure-http-dev-daemon.mjs')
const SHIM_ENTRY_PATH = resolve(import.meta.dirname, 'test-utils/fake-pnpm-shim.mjs')
const HOST = '127.0.0.1'
const LOG_PATH_SUFFIX = 'tmp/logs/mcp-http-dev.log'

/** Attempts allowed when another process wins the port before the hook probes it. */
const PORT_CONFLICT_ATTEMPTS = 3

async function reserveFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const tester = createServer()
    tester.once('error', rejectPort)
    tester.listen(0, HOST, () => {
      const address = tester.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      tester.close(() => {
        if (port === undefined) {
          rejectPort(new Error('failed to reserve a free port'))
          return
        }
        resolvePort(port)
      })
    })
  })
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
  const cleanupDirs: string[] = []
  let cleanupResponder: (() => Promise<void>) | undefined

  afterEach(async () => {
    for (const pid of cleanupPids.splice(0)) killQuietly(pid)
    if (cleanupResponder) {
      await cleanupResponder()
      cleanupResponder = undefined
    }
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Reserves a free port, a temp data dir and a PATH shim dir (both
   * registered for cleanup), and returns the env every hook run shares.
   * Per-case behavior is layered on by spreading extra FAKE_PNPM_* /
   * WHITEBOARD_DEV_READY_TIMEOUT_MS entries over `env`.
   *
   * The fake daemon never writes an identity marker (unlike the real one),
   * so a fresh data dir also exercises the no-marker self-heal path
   * (verifyDevDaemonIdentity -> 'no-marker' -> isSelfHealableIdentity).
   */
  async function prepareHookRun(): Promise<{
    port: number
    token: string
    dataDir: string
    invokedSentinelPath: string
    invokedSentinelDir: string
    lockPath: string
    countSpawns: () => number
    env: NodeJS.ProcessEnv
  }> {
    const port = await reserveFreePort()
    const token = randomUUID()
    const dataDir = mkdtempSync(join(tmpdir(), 'ensure-http-dev-daemon-data-'))
    const shimDir = writePnpmShimDir()
    cleanupDirs.push(dataDir, shimDir)
    const invokedSentinelPath = join(dataDir, 'invoked-sentinel.json')
    const invokedSentinelDir = join(dataDir, 'invoked-sentinels')
    const lockPath = join(dataDir, 'dev-daemon-spawn.lock')
    const countSpawns = () =>
      existsSync(invokedSentinelDir) ? readdirSync(invokedSentinelDir).length : 0

    return {
      port,
      token,
      dataDir,
      invokedSentinelPath,
      invokedSentinelDir,
      lockPath,
      countSpawns,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        WHITEBOARD_DEV_PORT: String(port),
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
      const { port, invokedSentinelPath, env } = await prepareHookRun()

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
      expect(stderr).toContain(String(port))
      expect(stderr).toContain(LOG_PATH_SUFFIX)
      expect(stderr).toContain('MCP tools will be unavailable')

      cleanupPids.push(readSentinel<{ pid: number }>(invokedSentinelPath).pid)
    },
  )

  itPosix(
    'is a no-op when our authenticated daemon is already up with a matching identity marker (fast path preserved)',
    async () => {
      const { port, token, dataDir, invokedSentinelPath, lockPath, env } = await prepareHookRun()

      const responder = await startFakeMcpResponder({ port, token, host: HOST })
      cleanupResponder = responder.close
      writeFileSync(
        join(dataDir, 'dev-daemon.json'),
        JSON.stringify({
          port,
          repoRoot: REPO_ROOT,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      )

      const { exitCode, stderr } = await runHook(env)

      expect(exitCode, `hook stderr:\n${stderr}`).toBe(0)
      expect(() => readFileSync(invokedSentinelPath, 'utf8')).toThrow()
      // The fast path must never touch the lock: no spawn decision was made.
      expect(existsSync(lockPath)).toBe(false)
    },
  )

  itPosix(
    'THE RED TEST: two concurrent hooks against the same free port produce exactly one spawn, both exit 0',
    async () => {
      // The hook only makes a spawn decision when it finds the port free, so
      // the gap between picking a port number and probing it cannot be closed
      // — and this suite runs beside other tests that bind ephemeral ports.
      // When one of them is handed this port first, the hook correctly refuses
      // the foreign listener. That is a precondition we failed to establish,
      // not a result about the spawn lock, so it earns a fresh port rather
      // than a red build. The retry is bounded: the last attempt asserts, so
      // a persistent conflict still fails with the hook's own message.
      for (let attempt = 1; ; attempt++) {
        const { invokedSentinelDir, countSpawns, env } = await prepareHookRun()

        const runEnv = {
          ...env,
          WHITEBOARD_DEV_READY_TIMEOUT_MS: '8000',
          FAKE_PNPM_BIND_DELAY_MS: '500',
        }

        const [first, second] = await Promise.all([runHook(runEnv), runHook(runEnv)])

        const portStolen = [first, second].some((result) => /is in use but /.test(result.stderr))
        if (portStolen && attempt < PORT_CONFLICT_ATTEMPTS) {
          killAllSpawnedPids(invokedSentinelDir)
          continue
        }

        expect(
          first.exitCode,
          `hook 1 stderr:\n${first.stderr}\nhook 1 stdout:\n${first.stdout}`,
        ).toBe(0)
        expect(
          second.exitCode,
          `hook 2 stderr:\n${second.stderr}\nhook 2 stdout:\n${second.stdout}`,
        ).toBe(0)
        // The discriminating assertion: exactly one process was ever spawned.
        // On unpatched main, both hooks observe the port free and both spawn.
        expect(countSpawns()).toBe(1)

        killAllSpawnedPids(invokedSentinelDir)
        return
      }
    },
  )

  itPosix(
    'writes the reason to the daemon log when the spawned dev server cannot bind',
    async () => {
      const { port, env } = await prepareHookRun()
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
      expect(log).toContain(String(port))
    },
  )

  itPosix(
    'fails loudly when a colliding worktree answers the readiness probe right after our own spawn (post-spawn TOCTOU)',
    async () => {
      const { port, dataDir, invokedSentinelPath, env } = await prepareHookRun()

      // Simulates the race this branch guards against: our spawn's readiness
      // probe succeeds, but the identity marker written at bind time belongs
      // to a different worktree (same derived port, different repoRoot) —
      // i.e. a colliding worktree's daemon answered instead of ours.
      const foreignMarker = JSON.stringify({
        port,
        repoRoot: '/some/other/worktree',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })

      const { exitCode, stderr } = await runHook({
        ...env,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '8000',
        FAKE_PNPM_MARKER_JSON: foreignMarker,
      })

      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('startup race with another worktree')
      expect(stderr).toContain(String(port))

      // The fake daemon stays up despite the hook's failure — clean it up.
      cleanupPids.push(readSentinel<{ pid: number }>(invokedSentinelPath).pid)
      expect(existsSync(join(dataDir, 'dev-daemon.json'))).toBe(true)
    },
  )

  itPosix(
    'a stale lock (dead recorded pid) does not block a spawn, and the hook still terminates within its bound',
    async () => {
      const { lockPath, invokedSentinelDir, countSpawns, env } = await prepareHookRun()

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

      killAllSpawnedPids(invokedSentinelDir)
    },
  )
})
