// The wrapper behind `pnpm mcp:http:dev` runs the daemon as a CHILD
// (`tsx watch`). A stop signal sent to the wrapper has to reach that child,
// or the wrapper dies and leaves the watcher and its daemon holding the
// socket, so the next start is refused with "another daemon is already
// listening". The wrapper resolves its child from the git checkout it runs in,
// so this runs the real script in a throwaway checkout whose `tsx` is a
// long-running stand-in.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startFakeMcpResponder } from './test-utils/fake-mcp-daemon.mjs'

const WRAPPER = resolve(import.meta.dirname, 'with-dev-data-dir.mjs')
const STOP = resolve(import.meta.dirname, 'stop-http-dev-daemon.mjs')

const cleanups: Array<() => unknown> = []
// Last registered runs first: a process is killed before the checkout holding
// its pid file is removed.
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** Kills whatever pid `pidFile` names, if the child got as far as writing it. */
function killRecordedChild(pidFile: string) {
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8'))
  if (alive(pid)) process.kill(pid, 'SIGKILL')
}

/** A checkout whose `tsx` writes its pid, then runs until signalled — and exits with `exitCode` if told to. */
function fakeCheckout(): { cwd: string; pidFile: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'wb-with-dev-data-dir-'))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', cwd])
  mkdirSync(join(cwd, 'data'), { recursive: true })
  const tsxDir = join(cwd, 'packages/mcp-server/node_modules/tsx/dist')
  mkdirSync(tsxDir, { recursive: true })
  const pidFile = join(cwd, 'child.pid')
  writeFileSync(
    join(tsxDir, 'cli.mjs'),
    `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
writeFileSync(${JSON.stringify(join(cwd, 'data', 'daemon.json'))}, JSON.stringify({ pid: process.pid, socketPath: '/x.sock', token: 't' }))
if (process.env.FAKE_TSX_EXIT_CODE) process.on('SIGTERM', () => process.exit(Number(process.env.FAKE_TSX_EXIT_CODE)))
setInterval(() => {}, 1000)
`,
  )
  return { cwd, pidFile }
}

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(`timed out waiting for ${what}`)
    },
    { timeout: timeoutMs, interval: 25 },
  )
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function runStop(cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const stop = spawn(process.execPath, [STOP], {
      cwd,
      env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data') },
    })
    let stdout = ''
    let stderr = ''
    stop.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    stop.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    stop.once('close', (status) => done({ status, stdout, stderr }))
  })
}

function runWrapper(cwd: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const wrapper = spawn(process.execPath, [WRAPPER], {
      cwd,
      env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data') },
    })
    cleanups.push(() => {
      killRecordedChild(join(cwd, 'child.pid'))
      wrapper.kill('SIGKILL')
    })
    let stderr = ''
    wrapper.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    wrapper.once('close', (status) => done({ status, stderr }))
  })
}

async function startWrapper(env: Record<string, string> = {}) {
  const { cwd, pidFile } = fakeCheckout()
  const wrapper: ChildProcess = spawn(process.execPath, [WRAPPER], {
    cwd,
    env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data'), ...env },
    stdio: 'ignore',
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    wrapper.once('exit', (code, signal) => done({ code, signal })),
  )
  await until(
    () => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '',
    'the child to start',
  )
  const childPid = Number(readFileSync(pidFile, 'utf8'))
  cleanups.push(() => {
    if (alive(childPid)) process.kill(childPid, 'SIGKILL')
    wrapper.kill('SIGKILL')
  })
  return { wrapper, exited, childPid, cwd }
}

describe('with-dev-data-dir.mjs forwards stop signals to the dev server it runs', () => {
  it.each([
    'SIGTERM',
    'SIGINT',
    'SIGHUP',
  ] as const)('a %s to the wrapper stops its child, and the wrapper ends with it', async (signal) => {
    const { wrapper, exited, childPid } = await startWrapper()
    expect(alive(childPid)).toBe(true)

    wrapper.kill(signal)
    await exited

    await until(() => !alive(childPid), 'the child to die with its wrapper')
  })

  it("exits with the child's own exit code when the child handles the signal", async () => {
    const { wrapper, exited } = await startWrapper({ FAKE_TSX_EXIT_CODE: '7' })
    wrapper.kill('SIGTERM')
    expect((await exited).code).toBe(7)
  })

  it('ends by the signal when the child dies of it, rather than hanging on its own handler', async () => {
    const { wrapper, exited } = await startWrapper()
    wrapper.kill('SIGTERM')
    expect((await exited).signal).toBe('SIGTERM')
  })
})

describe("pnpm mcp:http:stop stops this checkout's dev daemon through the wrapper", () => {
  it('ends the wrapper and the child, and leaves no pid file behind', async () => {
    const { exited, childPid, cwd } = await startWrapper()
    const pidPath = join(cwd, 'data', 'dev-wrapper.pid')
    expect(existsSync(pidPath)).toBe(true)

    // Async, not spawnSync: the wrapper is this process's child, and a blocked
    // event loop cannot reap it, so it would read as still running.
    const stop = await runStop(cwd)
    expect(stop.status, stop.stderr).toBe(0)
    expect(stop.stdout).toMatch(/stopped the dev daemon/)

    await exited
    await until(() => !alive(childPid), 'the child to die')
    expect(existsSync(pidPath)).toBe(false)
  })

  it('says so, and succeeds, when nothing is running', () => {
    const { cwd } = fakeCheckout()
    const stop = spawnSync(process.execPath, [STOP], {
      cwd,
      env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data') },
      encoding: 'utf8',
    })
    expect(stop.status).toBe(0)
    expect(stop.stdout).toMatch(/no dev daemon is running/)
  })
})

// A second start on a data dir whose daemon is running has nothing to serve:
// its daemon could not take the socket. It hands over to the running one and
// succeeds, so `pnpm dev` and `pnpm mcp:debug:http` keep their other half
// beside the SessionStart hook's daemon. What it must not do is clobber the
// running one's bookkeeping on the way out — the record is how every client
// finds the daemon, and the pid file is what `pnpm mcp:http:stop` signals.
describe('a second with-dev-data-dir.mjs on a data dir whose daemon is running', () => {
  it('reuses it without starting a watcher, and leaves the running pair the record and pid file', async () => {
    const { wrapper, childPid, cwd } = await startWrapper()
    const recordPath = join(cwd, 'data', 'daemon.json')
    const pidPath = join(cwd, 'data', 'dev-wrapper.pid')
    await until(() => existsSync(pidPath), 'the first wrapper to record its pid')

    const second = spawnSync(process.execPath, [WRAPPER], {
      cwd,
      env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data') },
      encoding: 'utf8',
      timeout: 10_000,
    })

    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toMatch(new RegExp(`reusing the dev daemon .*pid ${childPid}`))
    expect(second.stderr).toMatch(/pnpm mcp:http:stop/)
    expect(JSON.parse(readFileSync(recordPath, 'utf8')).pid).toBe(childPid)
    expect(readFileSync(pidPath, 'utf8')).toBe(String(wrapper.pid))
    expect(alive(childPid)).toBe(true)
  })

  it('reuses a daemon that answers its socket, and starts no watcher', async () => {
    const { cwd, pidFile } = fakeCheckout()
    const socketPath = join(cwd, 'data', 'daemon.sock')
    const responder = await startFakeMcpResponder({ socketPath, token: 't' })
    cleanups.push(() => void responder.close())
    writeFileSync(
      join(cwd, 'data', 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        socketPath,
        token: 't',
        startedAt: new Date().toISOString(),
      }),
    )

    const second = await runWrapper(cwd)

    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toMatch(/reusing the dev daemon/)
    expect(existsSync(pidFile)).toBe(false)
  })
})

// A daemon killed outright leaves its record behind. Nothing holds the socket,
// so refusing — or "reusing" — that record would leave the checkout with no
// daemon at all until someone deletes the file by hand. Needs no /proc: a
// reaped pid is dead on every platform.
describe('a data dir whose record names a pid that has exited', () => {
  it('the wrapper starts the dev server instead of reusing the stale record', async () => {
    const { cwd, pidFile } = fakeCheckout()
    const reaped = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(
      join(cwd, 'data', 'daemon.json'),
      JSON.stringify({
        pid: reaped,
        socketPath: join(cwd, 'data', 'gone.sock'),
        token: 't',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    )
    const wrapper = spawn(process.execPath, [WRAPPER], {
      cwd,
      env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data') },
      stdio: 'ignore',
    })
    let exited = false
    wrapper.once('exit', () => {
      exited = true
    })
    cleanups.push(() => {
      killRecordedChild(pidFile)
      wrapper.kill('SIGKILL')
    })
    await until(() => existsSync(pidFile) || exited, 'the wrapper to start its child or exit')
    expect(existsSync(pidFile), 'the wrapper exited without starting its child').toBe(true)
  })
})

describe.skipIf(!existsSync('/proc/self/stat'))(
  'a data dir whose record names a pid an unrelated process has taken',
  () => {
    /** A record left by a daemon that died a minute ago, its pid now a stand-in's. */
    function staleRecordInCheckout(): { cwd: string; pidFile: string; standIn: ChildProcess } {
      const checkout = fakeCheckout()
      const standIn = spawn('sleep', ['30'], { stdio: 'ignore' })
      cleanups.push(() => standIn.kill('SIGKILL'))
      writeFileSync(
        join(checkout.cwd, 'data', 'daemon.json'),
        JSON.stringify({
          pid: standIn.pid,
          socketPath: join(checkout.cwd, 'data', 'gone.sock'),
          token: 't',
          startedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      )
      return { ...checkout, standIn }
    }

    it('the wrapper starts the dev server instead of refusing', async () => {
      const { cwd, pidFile } = staleRecordInCheckout()
      const wrapper = spawn(process.execPath, [WRAPPER], {
        cwd,
        env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data') },
        stdio: 'ignore',
      })
      cleanups.push(() => {
        killRecordedChild(pidFile)
        wrapper.kill('SIGKILL')
      })
      await until(() => existsSync(pidFile), 'the wrapper to start its child')
      expect(wrapper.exitCode).toBeNull()
    })

    it('pnpm mcp:http:stop signals nothing, and says why', async () => {
      const { cwd, standIn } = staleRecordInCheckout()
      const stop = await runStop(cwd)
      expect(stop.status, stop.stderr).toBe(0)
      expect(stop.stdout).toMatch(/started after the record was written/)
      expect(stop.stdout).toMatch(/not signalled/)
      expect(standIn.exitCode).toBeNull()
      expect(alive(standIn.pid as number)).toBe(true)
    })
  },
)
