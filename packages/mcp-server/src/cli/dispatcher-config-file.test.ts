import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../server/log.js'

// Exercises the REAL dispatcher path (`whiteboard daemon run`) with a config
// file on disk, mocking only `daemon-run.js` so we can inspect exactly what
// options the dispatcher resolved (dataDir / token) without booting a server.

const runDaemonRun = vi.fn(async () => ({
  kind: 'refused' as const,
  message: 'stubbed',
}))
vi.mock('./daemon-run.js', () => ({ runDaemonRun }))

const { main } = await import('./dispatcher.js')

let dir: string
let originalCwd: string
const ENV_KEYS = [
  'WHITEBOARD_TOKEN',
  'WHITEBOARD_DAEMON_TOKEN',
  'WHITEBOARD_LOG_LEVEL',
  'WHITEBOARD_DATA_DIR',
] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whiteboard-dispatcher-config-'))
  originalCwd = process.cwd()
  process.chdir(dir)
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  runDaemonRun.mockClear()
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('whiteboard daemon run — config file wiring', () => {
  it('threads config-file dataDir and token into the run', async () => {
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      JSON.stringify({
        dataDir: join(dir, 'data'),
        token: 'file-token-value',
      }),
    )

    const capture = captureLogsForTests()
    try {
      await main(['daemon', 'run', '--json'])
    } finally {
      capture.restore()
    }

    expect(runDaemonRun).toHaveBeenCalledTimes(1)
    expect(process.env.WHITEBOARD_DATA_DIR).toBe(join(dir, 'data'))
    expect(process.env.WHITEBOARD_TOKEN).toBe('file-token-value')
    expect(process.env.WHITEBOARD_DAEMON_TOKEN).toBe('file-token-value')

    const loadRecord = capture.records.find((r) => r.msg.includes('loaded whiteboard config file'))
    expect(loadRecord).toBeDefined()
    expect(loadRecord?.data?.filepath).toMatch(/\.whiteboardrc\.json$/)
    expect(JSON.stringify(capture.records)).not.toContain('file-token-value')
  })

  it('--data-dir on the CLI beats the config file dataDir', async () => {
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      JSON.stringify({ dataDir: join(dir, 'from-file') }),
    )
    await main(['daemon', 'run', '--json', `--data-dir=${join(dir, 'from-cli')}`])
    expect(process.env.WHITEBOARD_DATA_DIR).toBe(join(dir, 'from-cli'))
  })

  // The daemon listens on no port (ADR-0050), so a file still naming one is
  // told so and the rest of it is honoured, rather than the key being
  // silently dropped or refusing the whole start.
  it('warns about a config-file port and still runs the daemon', async () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ port: 4321 }))
    const capture = captureLogsForTests()
    try {
      await main(['daemon', 'run', '--json'])
    } finally {
      capture.restore()
    }
    expect(runDaemonRun).toHaveBeenCalledTimes(1)
    expect(runDaemonRun.mock.calls[0][0]).not.toHaveProperty('port')
    const warning = capture.records.find((r) => r.msg.includes('unknown whiteboard config'))
    expect(warning?.data?.unknownKeys).toEqual(['port'])
  })

  it('reports an invalid config file as a clean exit-1 error instead of an unhandled rejection', async () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ logLevel: 'not-a-level' }))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const exitCode = await main(['daemon', 'run', '--json'])
      expect(exitCode).toBe(1)
      expect(runDaemonRun).not.toHaveBeenCalled()
      const written = stderrSpy.mock.calls.map((call) => String(call[0])).join('')
      expect(written).toContain('.whiteboardrc.json')
      expect(written).not.toMatch(/\n\s*at /) // no raw stack trace frame
    } finally {
      stderrSpy.mockRestore()
    }
  })
})
