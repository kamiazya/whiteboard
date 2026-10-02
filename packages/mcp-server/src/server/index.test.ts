import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from './config.js'
import { captureLogsForTests } from './log.js'

const { startHttpServerMock, saveDaemonRecordMock, deleteDaemonRecordMock } = vi.hoisted(() => ({
  startHttpServerMock: vi.fn(async () => ({
    socketPath: '/run/user/1000/whiteboard/d.sock',
    getRuntimeStatus: () => ({ startedAt: '2026-01-01T00:00:00.000Z' }),
  })),
  saveDaemonRecordMock: vi.fn(async () => undefined),
  deleteDaemonRecordMock: vi.fn(async () => undefined),
}))

vi.mock('./http-server.js', () => ({ startHttpServer: startHttpServerMock }))
// Partial on purpose: `app.ts` reaches the backup pass through the McpServer
// factory's module, and `backup-restore.ts` reads `DAEMON_RECORD_FILENAME` at
// load — a mock that omits it fails the whole file before any test runs.
vi.mock('../daemon/daemon-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon/daemon-registry.js')>()),
  saveDaemonRecord: saveDaemonRecordMock,
  deleteDaemonRecord: deleteDaemonRecordMock,
}))
vi.mock('./security/mcp-auth.js', () => ({
  createLocalTokenMcpHttpAuthStrategy: vi.fn(() => ({})),
  resolveMcpProtectedResourceMetadataFromEnv: vi.fn(() => undefined),
}))
vi.mock('./observability/tracing.js', () => ({ initTracing: vi.fn(async () => undefined) }))
vi.mock('./store/db/prepare.js', () => ({ prepareDataDir: vi.fn(async () => undefined) }))
vi.mock('./export/headless-renderer.js', () => ({
  prewarmHeadlessExporter: vi.fn(async () => undefined),
}))

// This module has no top-level `main()` call: starting the daemon is
// `daemon-entry.ts`'s job. So importing it here is inert, and these tests call
// the exported `main` directly. It used to self-start behind an
// `isDirectEntryPoint` check that happened to be false under vitest; the split
// makes that inertness structural rather than a property of argv.
const { main } = await import('./index.js')

describe('server/index main() data dir startup log', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.WHITEBOARD_TOKEN
  })

  it('emits a notice-level record naming the resolved data dir before startHttpServer', async () => {
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const capture = captureLogsForTests('debug')
    try {
      await main()
      const record = capture.records.find((r) => r.scope === 'server-index' && r.level === 'notice')
      expect(record).toBeDefined()
      const dataDir = record?.data?.dataDir
      expect(typeof dataDir).toBe('string')
      expect((dataDir as string).length).toBeGreaterThan(0)
    } finally {
      capture.restore()
      stdoutSpy.mockRestore()
    }
  })
})

describe('server/index main() data dir threading', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
    resetDataDirForTests()
    vi.clearAllMocks()
    delete process.env.WHITEBOARD_TOKEN
  })

  it('passes the resolved dataDir (not the frozen DATA_DIR const) to saveDaemonRecord', async () => {
    const scratchDir = '/tmp/whiteboard-index-daemon-mode-test'
    setDataDirForTests(scratchDir)
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      expect(saveDaemonRecordMock).toHaveBeenCalledWith(
        expect.objectContaining({ pid: process.pid }),
        scratchDir,
      )
    } finally {
      stdoutSpy.mockRestore()
    }
  })

  it('passes the resolved dataDir to deleteDaemonRecord via the close callback', async () => {
    const scratchDir = '/tmp/whiteboard-index-daemon-mode-test-close'
    setDataDirForTests(scratchDir)
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      const onClose = startHttpServerMock.mock.calls[0][0].onClose as () => Promise<void>
      await onClose()
      expect(deleteDaemonRecordMock).toHaveBeenCalledWith(scratchDir)
    } finally {
      stdoutSpy.mockRestore()
    }
  })
})

// ADR-0050: the daemon listens on its owner-only socket and nowhere else.
describe('server/index main() listens on its socket alone', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.WHITEBOARD_TOKEN
  })

  it('hands startHttpServer a socket and no port or host, and records the socket', async () => {
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      const [options] = startHttpServerMock.mock.calls[0] as unknown as [Record<string, unknown>]
      expect(typeof options.socketPath).toBe('string')
      expect(options).not.toHaveProperty('port')
      expect(options).not.toHaveProperty('host')
      expect(saveDaemonRecordMock).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: '/run/user/1000/whiteboard/d.sock' }),
        expect.any(String),
      )
      expect(saveDaemonRecordMock.mock.calls[0]?.[0]).not.toHaveProperty('port')
    } finally {
      stdoutSpy.mockRestore()
    }
  })
})

describe('server/index main() storage settings startup gate', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    delete process.env.WHITEBOARD_FILE_GC_GRACE_MS
    delete process.env.WHITEBOARD_DATABASE_URL
  })

  it('aborts before startHttpServer when a duration carries a unit suffix', async () => {
    process.env.WHITEBOARD_FILE_GC_GRACE_MS = '1h'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const capture = captureLogsForTests('debug')
    try {
      await expect(main()).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(startHttpServerMock).not.toHaveBeenCalled()
      const record = capture.records.find((r) => r.scope === 'server-index' && r.level === 'error')
      expect(record).toBeDefined()
      expect(JSON.stringify(record)).toContain('WHITEBOARD_FILE_GC_GRACE_MS')
    } finally {
      capture.restore()
      exitSpy.mockRestore()
    }
  })

  it('names every bad setting at once, so one restart is enough to fix them', async () => {
    process.env.WHITEBOARD_FILE_GC_GRACE_MS = '1h'
    process.env.WHITEBOARD_DATABASE_URL = 'postgres://user:hunter2@db.example.com'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const capture = captureLogsForTests('debug')
    try {
      await expect(main()).rejects.toThrow('process.exit called')
      const record = capture.records.find((r) => r.scope === 'server-index' && r.level === 'error')
      const rendered = JSON.stringify(record)
      expect(rendered).toContain('WHITEBOARD_FILE_GC_GRACE_MS')
      expect(rendered).toContain('WHITEBOARD_DATABASE_URL')
      // Never the values: a database URL can carry a credential.
      expect(rendered).not.toContain('hunter2')
      expect(rendered).not.toContain('db.example.com')
    } finally {
      capture.restore()
      exitSpy.mockRestore()
    }
  })
})

describe('server/index main() WHITEBOARD_REPLICA_TIER wiring', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    delete process.env.WHITEBOARD_REPLICA_TIER
    delete process.env.WHITEBOARD_TOKEN
  })

  it('threads a valid override through to startHttpServer', async () => {
    process.env.WHITEBOARD_REPLICA_TIER = 'no-offline'
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(startHttpServerMock).toHaveBeenCalledWith(
        expect.objectContaining({ replicaTier: 'no-offline' }),
      )
    } finally {
      exitSpy.mockRestore()
      stdoutSpy.mockRestore()
    }
  })

  it('defaults to offline when the env var is unset', async () => {
    delete process.env.WHITEBOARD_REPLICA_TIER
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      expect(startHttpServerMock).toHaveBeenCalledWith(
        expect.objectContaining({ replicaTier: 'offline' }),
      )
    } finally {
      stdoutSpy.mockRestore()
    }
  })
})

describe('server/index main() config-file wiring', () => {
  let dir: string
  let originalCwd: string

  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.WHITEBOARD_TOKEN
    // Applying a config-file token writes WHITEBOARD_DAEMON_TOKEN as well
    // (config-file.ts), and the apply is skipped when EITHER is already set.
    // Leaving this one behind therefore makes the next run of this test a
    // silent no-op: the token never lands and the assertion reads `undefined`
    // as if the file had not been read at all. Only `--repeats` runs the body
    // twice in one process, which is why it survived until this file was
    // touched and the stress job picked it up.
    delete process.env.WHITEBOARD_DAEMON_TOKEN
    delete process.env.WHITEBOARD_DATA_DIR
    if (originalCwd) process.chdir(originalCwd)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('loads a config-file token into WHITEBOARD_TOKEN (env still wins if set)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'whiteboard-index-config-'))
    originalCwd = process.cwd()
    process.chdir(dir)
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ token: 'file-token' }))
    delete process.env.WHITEBOARD_TOKEN

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(process.env.WHITEBOARD_TOKEN).toBe('file-token')
    } finally {
      exitSpy.mockRestore()
      stdoutSpy.mockRestore()
    }
  })

  it('aborts cleanly with a structured log record on an invalid config file, instead of an unhandled throw', async () => {
    dir = mkdtempSync(join(tmpdir(), 'whiteboard-index-config-'))
    originalCwd = process.cwd()
    process.chdir(dir)
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ logLevel: 'not-a-level' }))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const capture = captureLogsForTests()
    try {
      await expect(main()).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(startHttpServerMock).not.toHaveBeenCalled()
      const record = capture.records.find((r) => r.scope === 'server-index' && r.level === 'error')
      expect(record).toBeDefined()
      expect(JSON.stringify(capture.records)).not.toMatch(/\n\s*at /)
    } finally {
      capture.restore()
      exitSpy.mockRestore()
    }
  })

  it('warns instead of honoring a config-file dataDir on this entrypoint', async () => {
    dir = mkdtempSync(join(tmpdir(), 'whiteboard-index-config-'))
    originalCwd = process.cwd()
    process.chdir(dir)
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      JSON.stringify({ token: 'file-token', dataDir: join(dir, 'data') }),
    )
    delete process.env.WHITEBOARD_TOKEN
    delete process.env.WHITEBOARD_DATA_DIR

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const capture = captureLogsForTests()
    try {
      await main()
      const warning = capture.records.find(
        (r) => r.scope === 'server-index' && r.msg.includes('dataDir is not honored'),
      )
      expect(warning).toBeDefined()
      // DATA_DIR (shared/data-dir-secure.ts) was resolved at module import
      // time and never sees the file value, so writing it to the env anyway
      // would give later env readers a dataDir the running server is NOT
      // using. The entrypoint must not apply it at all.
      expect(process.env.WHITEBOARD_DATA_DIR).toBeUndefined()
    } finally {
      capture.restore()
      exitSpy.mockRestore()
      stdoutSpy.mockRestore()
    }
  })
})
