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
import { afterEach, describe, expect, it } from 'vitest'

const WRAPPER = resolve(import.meta.dirname, 'with-dev-data-dir.mjs')
const STOP = resolve(import.meta.dirname, 'stop-http-dev-daemon.mjs')

const cleanups: Array<() => unknown> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

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
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
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
