// The wrapper behind `pnpm mcp:http:dev` runs the daemon as a CHILD
// (`tsx watch`). A stop signal sent to the wrapper has to reach that child,
// or the wrapper dies and leaves the watcher and its daemon holding the
// socket, so the next start is refused with "another daemon is already
// listening". The wrapper resolves its child from the git checkout it runs in,
// so this runs the real script in a throwaway checkout whose `tsx` is a
// long-running stand-in.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createSocketServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRecord } from '../../src/daemon/daemon-record-schema.js'
import { BUILT_LAUNCH } from './dev-daemon-socket-lib.mjs'
import { startFakeMcpResponder } from './test-utils/fake-mcp-daemon.mjs'
import { devSpawnLockPath } from './with-dev-data-dir-lib.mjs'

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

/**
 * A checkout whose `tsx` writes its pid, then runs until signalled — and exits
 * with `FAKE_TSX_EXIT_CODE` if told to. Every child also leaves its pid under
 * `children/`, so a test can count how many watchers a start produced. A
 * `gated` checkout's child writes its daemon record only once `release`
 * exists, holding the daemon's boot window open for as long as a test needs.
 */
function fakeCheckout({ gated = false }: { gated?: boolean } = {}): {
  cwd: string
  pidFile: string
} {
  const cwd = mkdtempSync(join(tmpdir(), 'wb-with-dev-data-dir-'))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', cwd])
  // Owner-only, as a real data dir is: the fixtures put their sockets here,
  // and a socket in a directory others can enter is never sent a token.
  mkdirSync(join(cwd, 'data'), { recursive: true, mode: 0o700 })
  mkdirSync(join(cwd, 'children'), { recursive: true })
  const tsxDir = join(cwd, 'packages/mcp-server/node_modules/tsx/dist')
  mkdirSync(tsxDir, { recursive: true })
  const pidFile = join(cwd, 'child.pid')
  const record = JSON.stringify(join(cwd, 'data', 'daemon.json'))
  const release = JSON.stringify(join(cwd, 'release'))
  writeFileSync(
    join(tsxDir, 'cli.mjs'),
    `import { existsSync, writeFileSync } from 'node:fs'
if (process.env.FAKE_TSX_EXIT_CODE) process.on('SIGTERM', () => process.exit(Number(process.env.FAKE_TSX_EXIT_CODE)))
writeFileSync(${JSON.stringify(join(cwd, 'children'))} + '/' + process.pid, '')
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const writeRecord = () => writeFileSync(${record}, JSON.stringify({ pid: process.pid, socketPath: '/x.sock', token: 't' }))
if (${gated}) {
  const gate = setInterval(() => {
    if (existsSync(${release})) {
      clearInterval(gate)
      writeRecord()
    }
  }, 20)
} else writeRecord()
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
    const { wrapper, exited, childPid, cwd } = await startWrapper()
    const pidPath = join(cwd, 'data', 'dev-wrapper.pid')
    expect(existsSync(pidPath)).toBe(true)

    // Async, not spawnSync: the wrapper is this process's child, and a blocked
    // event loop cannot reap it, so it would read as still running.
    const stop = await runStop(cwd)
    expect(stop.status, stop.stderr).toBe(0)
    // Named, not inferred from the wrapper exiting: here the daemon's death
    // also ends the wrapper, so a stop that signalled only the daemon would
    // pass every other assertion while being unable to end an orphaned wrapper.
    expect(stop.stdout).toContain(
      `stopped the dev daemon for ${join(cwd, 'data')} (signalled the wrapper, pid ${wrapper.pid})`,
    )

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

  // The record's pid started after it, so only the socket speaks for the
  // daemon: the line names the ask that went unanswered and does not vouch
  // for a pid nothing confirmed.
  it('hands over to a wedged socket naming the status ask and an unconfirmed pid', async () => {
    const { cwd, pidFile } = fakeCheckout()
    const socketPath = join(cwd, 'data', 'wedged.sock')
    const held: Socket[] = []
    const wedged = createSocketServer((socket) => held.push(socket))
    await new Promise<void>((listening) => wedged.listen(socketPath, () => listening()))
    cleanups.push(() => {
      for (const socket of held) socket.destroy()
      wedged.close()
    })
    writeFileSync(
      join(cwd, 'data', 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        socketPath,
        token: 't',
        startedAt: '2000-01-01T00:00:00.000Z',
      }),
    )

    const second = await runWrapper(cwd)

    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toContain(
      `(recorded pid ${process.pid}, unconfirmed) (busy: it did not answer /api/runtime/status within 1500ms)`,
    )
    expect(existsSync(pidFile)).toBe(false)
  }, 30_000)

  // A built daemon runs dist/, so handing a watch-mode start over to it as if
  // it were the dev daemon leaves every source edit without effect.
  it('names a running BUILT daemon as such, and says source edits will not reload it', async () => {
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
        version: '0.0.0-test',
        launch: BUILT_LAUNCH,
      } satisfies DaemonRecord),
    )

    const second = await runWrapper(cwd)

    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toMatch(
      new RegExp(
        `the BUILT daemon \\(pid ${process.pid}, running a build, not this checkout's source\\)`,
      ),
    )
    expect(second.stderr).toMatch(/source edits will not reload it/)
    expect(second.stderr).toMatch(/`pnpm mcp:http:stop` first/)
    expect(second.stderr).not.toMatch(/reusing the dev daemon/)
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

  // The record on disk is the dead daemon's until the new one writes its own,
  // so it cannot end the boot window: a second start let in then would race
  // this daemon's migrations.
  it('holds the spawn lock through the boot window instead of reading the stale record as up', async () => {
    const { cwd } = fakeCheckout({ gated: true })
    const lockPath = devSpawnLockPath(join(cwd, 'data'))
    writeFileSync(
      join(cwd, 'data', 'daemon.json'),
      JSON.stringify({
        pid: spawnSync(process.execPath, ['-e', '']).pid,
        socketPath: join(cwd, 'data', 'gone.sock'),
        token: 't',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    )
    const wrapper = launchWrapper(cwd)
    await until(() => children(cwd).length === 1, 'the wrapper to start its watcher', 30_000)

    expect(existsSync(lockPath), 'the lock was let go before the daemon wrote its record').toBe(
      true,
    )
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(wrapper.process.pid)
    writeFileSync(join(cwd, 'release'), '')
    await until(() => !existsSync(lockPath), 'the wrapper to let go once its daemon is up', 30_000)
    expect(wrapper.exit).toBeNull()
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

/** The pids of every child a wrapper in this checkout has started. */
function children(cwd: string): number[] {
  return readdirSync(join(cwd, 'children')).map(Number)
}

/** A wrapper whose stderr and exit are collected, killed with its children afterwards. */
function launchWrapper(cwd: string) {
  const process_ = spawn(process.execPath, [WRAPPER], {
    cwd,
    env: { ...process.env, WHITEBOARD_DATA_DIR: join(cwd, 'data') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const state = { stderr: '', exit: null as number | null | 'signal', process: process_ }
  process_.stderr?.on('data', (chunk) => {
    state.stderr += chunk
  })
  process_.once('exit', (code) => {
    state.exit = code ?? 'signal'
  })
  cleanups.push(() => {
    for (const pid of children(cwd)) if (alive(pid)) process.kill(pid, 'SIGKILL')
    process_.kill('SIGKILL')
  })
  return state
}

// Until a daemon has written its record, nothing on disk says one is coming:
// two starts inside that boot window would each start a watcher, the loser's
// daemon dies on the socket, and its `tsx watch` stays behind — out of reach
// of `pnpm mcp:http:stop` and bringing a daemon back on every source edit.
describe('two with-dev-data-dir.mjs started together on one data dir', () => {
  it('start one watcher, and the other hands over once its daemon is up', async () => {
    const { cwd } = fakeCheckout({ gated: true })
    const pidPath = join(cwd, 'data', 'dev-wrapper.pid')
    const a = launchWrapper(cwd)
    const b = launchWrapper(cwd)

    await until(
      () =>
        children(cwd).length > 1 ||
        (children(cwd).length === 1 && /another dev daemon is starting/.test(a.stderr + b.stderr)),
      'one wrapper to start a watcher and the other to wait for it',
      30_000,
    )
    expect(children(cwd)).toHaveLength(1)
    writeFileSync(join(cwd, 'release'), '')
    await until(
      () => a.exit !== null || b.exit !== null,
      'the waiting wrapper to hand over',
      30_000,
    )

    const [loser, winner] = a.exit !== null ? [a, b] : [b, a]
    expect(loser.exit, loser.stderr).toBe(0)
    expect(loser.stderr).toMatch(/reusing the dev daemon/)
    expect(winner.exit).toBeNull()
    expect(readFileSync(pidPath, 'utf8')).toBe(String(winner.process.pid))
    expect(children(cwd)).toHaveLength(1)
  })
})

// `pnpm mcp:http:stop` signals whatever `dev-wrapper.pid` names, so the file
// belongs to the wrapper that created it and to no other.
describe("with-dev-data-dir.mjs and another wrapper's pid file", () => {
  it('refuses to start a second watcher beside a wrapper that is still running', async () => {
    const { cwd } = fakeCheckout()
    const pidPath = join(cwd, 'data', 'dev-wrapper.pid')
    writeFileSync(pidPath, String(process.pid))

    const second = launchWrapper(cwd)
    await until(() => second.exit !== null, 'the second wrapper to exit', 30_000)

    expect(second.exit).toBe(1)
    expect(second.stderr).toMatch(new RegExp(`dev wrapper .*pid ${process.pid}.* already running`))
    expect(children(cwd)).toHaveLength(0)
    expect(readFileSync(pidPath, 'utf8')).toBe(String(process.pid))
  })

  it('leaves the file in place on the way out once it names some other wrapper', async () => {
    const { wrapper, exited, cwd } = await startWrapper()
    const pidPath = join(cwd, 'data', 'dev-wrapper.pid')
    await until(() => existsSync(pidPath), 'the wrapper to record its pid')
    writeFileSync(pidPath, String(process.pid))

    wrapper.kill('SIGTERM')
    await exited

    expect(readFileSync(pidPath, 'utf8')).toBe(String(process.pid))
  })
})

// The SessionStart hook takes the spawn lock and then starts this wrapper as
// its direct child; the wrapper boots under its parent's lock rather than
// waiting on it.
describe('with-dev-data-dir.mjs started by the holder of the spawn lock', () => {
  it('starts its watcher under the lock its parent holds', async () => {
    const { cwd } = fakeCheckout()
    const lockPath = devSpawnLockPath(join(cwd, 'data'))
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }))

    launchWrapper(cwd)
    await until(() => children(cwd).length === 1, 'the wrapper to start its watcher', 30_000)

    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid)
  })
})
