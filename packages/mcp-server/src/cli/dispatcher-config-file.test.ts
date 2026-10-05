import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../server/log.js'
import { captureStdio } from '../shared/test-utils/capture-stdio.js'
import type { runDaemonRun as RealRunDaemonRun } from './daemon-run.js'

// Exercises the REAL dispatcher path with a config file on disk, mocking each
// command's handler so we can inspect exactly which data directory the
// dispatcher resolved (and the token it layered) without booting a server.

const runDaemonRun = vi.fn<typeof RealRunDaemonRun>(async () => ({
  kind: 'refused' as const,
  message: 'stubbed',
}))
vi.mock('./daemon-run.js', () => ({ runDaemonRun }))

// What each stubbed handler was handed (or, for those that read the env
// themselves, the env value at the moment they ran), keyed by command.
const seen = new Map<string, string | undefined>()
const readDataDirFromEnv = () => process.env.WHITEBOARD_DATA_DIR
const answer = (key: string, dataDir: string | undefined) => {
  seen.set(key, dataDir)
}

vi.mock('./daemon-status.js', () => ({
  runDaemonStatus: vi.fn(async (o: { dataDir: string }) => {
    answer('daemon status', o.dataDir)
    return {
      result: { schemaVersion: 1, ok: true, reason: null, recordFound: true, recordFresh: true },
      exitCode: 0,
    }
  }),
}))
vi.mock('./daemon-doctor.js', () => ({
  runDaemonDoctor: vi.fn(async (o: { dataDir: string }) => {
    answer('daemon doctor', o.dataDir)
    return { result: { schemaVersion: 1, ok: true, status: 'ok', checks: [] }, exitCode: 0 }
  }),
}))
vi.mock('./daemon-stop.js', () => ({
  runDaemonStop: vi.fn(async (o: { dataDir: string }) => {
    answer('daemon stop', o.dataDir)
    return {
      result: { schemaVersion: 1, ok: true, action: 'not-running', reason: null, pid: null },
      exitCode: 0,
    }
  }),
}))
vi.mock('./daemon-support-bundle.js', () => ({
  runDaemonSupportBundle: vi.fn(async (o: { dataDir: string }) => {
    answer('daemon support-bundle', o.dataDir)
    return { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 }
  }),
}))
vi.mock('./daemon-replica-posture.js', () => ({
  runDaemonRotateReplicaKey: vi.fn(async (o: { dataDir: string }) => {
    answer('daemon rotate-replica-key', o.dataDir)
    return {
      result: { schemaVersion: 1, ok: true, workspaceId: 'ws-1', keyId: 'k' },
      exitCode: 0,
    }
  }),
  runDaemonSetReplicaTier: vi.fn(async (o: { dataDir: string }) => {
    answer('daemon set-replica-tier', o.dataDir)
    return {
      result: {
        schemaVersion: 1,
        ok: true,
        workspaceId: 'ws-1',
        tier: null,
        effectiveTier: 'offline',
      },
      exitCode: 0,
    }
  }),
}))
vi.mock('./search-fetch-model.js', () => ({
  runSearchFetchModel: vi.fn(async (o: { cacheDir: string }) => {
    answer('search fetch-model', o.cacheDir)
    return {
      result: {
        schemaVersion: 1,
        kind: 'ok',
        ok: true,
        cacheDir: o.cacheDir,
        model: 'm',
        dtype: 'q8',
        dimensions: 384,
        elapsedMs: 1,
      },
      exitCode: 0,
    }
  }),
}))
vi.mock('./native-host.js', () => ({
  dispatchNativeHost: vi.fn(async () => {
    answer('native-host install', readDataDirFromEnv())
    return 0
  }),
}))
vi.mock('../server/stdio-root.js', () => ({
  main: vi.fn(async () => {
    answer('mcp', readDataDirFromEnv())
    throw new Error('stubbed stdio server')
  }),
}))
vi.mock('./server-status.js', () => ({
  runServerStatus: vi.fn(async (o: { dataDir: string }) => {
    answer('server status', o.dataDir)
    return {
      result: {
        schemaVersion: 1,
        ok: true,
        state: 'running',
        pid: 42,
        host: '127.0.0.1',
        port: 3099,
        publicBaseUrl: 'https://wb.example.com',
        authStrategy: 'oauth-jwt',
        startedAt: '2026-05-21T00:00:00.000Z',
        recordFresh: true,
      },
      exitCode: 0,
    }
  }),
}))

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
  seen.clear()
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
    const { result: exitCode, stderr } = await captureStdio(() => main(['daemon', 'run', '--json']))
    expect(exitCode).toBe(1)
    expect(runDaemonRun).not.toHaveBeenCalled()
    expect(stderr).toContain('.whiteboardrc.json')
    expect(stderr).not.toMatch(/\n\s*at /) // no raw stack trace frame
  })
})

// A config file's `dataDir` used to steer `daemon run` alone, so the daemon
// landed in the file's directory while `daemon status` from the same cwd looked
// in `~/.whiteboard` and answered "record not found". The data directory is
// what every one of these commands locates the daemon by.
describe('config-file dataDir reaches every command that locates the local daemon', () => {
  const FROM_FILE = () => join(dir, 'from-file')
  const writeConfig = () =>
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ dataDir: FROM_FILE() }))

  const COMMANDS: readonly { key: string; argv: () => string[] }[] = [
    { key: 'daemon status', argv: () => ['daemon', 'status', '--json'] },
    { key: 'daemon doctor', argv: () => ['daemon', 'doctor', '--json'] },
    { key: 'daemon stop', argv: () => ['daemon', 'stop', '--json'] },
    {
      key: 'daemon support-bundle',
      argv: () => ['daemon', 'support-bundle', '--json', `--output-dir=${join(dir, 'bundle')}`],
    },
    {
      key: 'daemon rotate-replica-key',
      argv: () => ['daemon', 'rotate-replica-key', '--json', '--workspace=ws-1'],
    },
    {
      key: 'daemon set-replica-tier',
      argv: () => ['daemon', 'set-replica-tier', '--json', '--workspace=ws-1', '--tier=offline'],
    },
    { key: 'native-host install', argv: () => ['native-host', 'install', '--json'] },
    { key: 'mcp', argv: () => ['mcp'] },
    { key: 'search fetch-model', argv: () => ['search', 'fetch-model', '--json'] },
  ]

  it.each(COMMANDS)('$key resolves the file dataDir', async ({ key, argv }) => {
    writeConfig()
    await captureStdio(() => main(argv()))
    expect(seen.get(key)).toContain(FROM_FILE())
  })

  it('agrees with `daemon run` on where the daemon lives', async () => {
    writeConfig()
    await captureStdio(() => main(['daemon', 'run', '--json']))
    const runDataDir = process.env.WHITEBOARD_DATA_DIR
    delete process.env.WHITEBOARD_DATA_DIR
    await captureStdio(() => main(['daemon', 'status', '--json']))
    expect(seen.get('daemon status')).toBe(runDataDir)
  })

  it('keeps flag over env over file', async () => {
    writeConfig()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      process.env.WHITEBOARD_DATA_DIR = join(dir, 'from-env')
      await main(['daemon', 'status', '--json'])
      expect(seen.get('daemon status')).toBe(join(dir, 'from-env'))
      await main(['daemon', 'status', '--json', `--data-dir=${join(dir, 'from-flag')}`])
      expect(seen.get('daemon status')).toBe(join(dir, 'from-flag'))
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('leaves server mode alone: its data directory is flag or env, never the daemon file', async () => {
    writeConfig()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main(['server', 'status', '--json'])
      expect(seen.get('server status')).not.toContain(FROM_FILE())
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('fails a read-only command on an invalid config file instead of looking in the wrong place', async () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ dataDir: 7 }))
    const { result, stderr } = await captureStdio(() => main(['daemon', 'status', '--json']))
    expect(result).toBe(1)
    expect(seen.has('daemon status')).toBe(false)
    expect(stderr).toContain('.whiteboardrc.json')
  })
})
