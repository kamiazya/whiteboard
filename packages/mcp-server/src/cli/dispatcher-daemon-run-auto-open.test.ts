import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercises the REAL dispatcher path (`whiteboard daemon run`) for the
// 'running' outcome, mocking `daemon-run.js` (so no real server boots) and
// `daemon-run-auto-open.js` (so we can assert exactly what the dispatcher
// resolved for --no-open / config-file openBrowser without touching a real
// TTY, open(), or container probe).

const runDaemonRun = vi.fn(async () => ({
  kind: 'running' as const,
  result: {
    schemaVersion: 1 as const,
    ok: true as const,
    pid: process.pid,
    port: 3099,
    host: '127.0.0.1',
    version: '0.0.0-test',
    startedAt: new Date().toISOString(),
  },
}))
vi.mock('./daemon-run.js', () => ({ runDaemonRun }))

const maybeOpenDaemonBrowser = vi.fn(async () => undefined)
vi.mock('./daemon-run-auto-open.js', () => ({ maybeOpenDaemonBrowser }))

const { main } = await import('./dispatcher.js')

let dir: string
let originalCwd: string
const ENV_KEYS = [
  'WHITEBOARD_ALLOWED_WEB_ORIGINS',
  'WHITEBOARD_TOKEN',
  'WHITEBOARD_DAEMON_TOKEN',
  'WHITEBOARD_LOG_LEVEL',
  'WHITEBOARD_DATA_DIR',
] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whiteboard-dispatcher-auto-open-'))
  originalCwd = process.cwd()
  process.chdir(dir)
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  runDaemonRun.mockClear()
  maybeOpenDaemonBrowser.mockClear()
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function captureStdout(): { restore: () => void; get: () => string } {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    return true
  })
  return { restore: () => spy.mockRestore(), get: () => buf }
}

describe('whiteboard daemon run — auto-open-browser wiring', () => {
  it('calls maybeOpenDaemonBrowser with the resolved host/port after the ready JSON, with noOpenFlag=false by default', async () => {
    const stdout = captureStdout()
    const runningPromise = main(['daemon', 'run', '--json'])
    await new Promise<void>((r) => setImmediate(r))
    stdout.restore()

    const parsed = JSON.parse(stdout.get())
    expect(parsed.ok).toBe(true)
    expect(maybeOpenDaemonBrowser).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 3099,
      noOpenFlag: false,
      configOpenBrowser: undefined,
    })
    void runningPromise // never resolves; avoid unhandled-rejection warnings
  })

  it('threads --no-open through as noOpenFlag: true', async () => {
    const stdout = captureStdout()
    const runningPromise = main(['daemon', 'run', '--json', '--no-open'])
    await new Promise<void>((r) => setImmediate(r))
    stdout.restore()

    expect(maybeOpenDaemonBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ noOpenFlag: true }),
    )
    void runningPromise
  })

  it('threads a config-file openBrowser: false through as configOpenBrowser', async () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ openBrowser: false }))

    const stdout = captureStdout()
    const runningPromise = main(['daemon', 'run', '--json'])
    await new Promise<void>((r) => setImmediate(r))
    stdout.restore()

    expect(maybeOpenDaemonBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ configOpenBrowser: false }),
    )
    void runningPromise
  })
})
