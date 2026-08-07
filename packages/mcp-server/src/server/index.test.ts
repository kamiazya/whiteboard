import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from './config.js'
import { captureLogsForTests } from './log.js'

const { startHttpServerMock, saveDaemonRecordMock, deleteDaemonRecordMock } = vi.hoisted(() => ({
  startHttpServerMock: vi.fn(async () => ({
    port: 3099,
    getRuntimeStatus: () => ({ startedAt: '2026-01-01T00:00:00.000Z' }),
  })),
  saveDaemonRecordMock: vi.fn(async () => undefined),
  deleteDaemonRecordMock: vi.fn(async () => undefined),
}))

vi.mock('./http-server.js', () => ({ startHttpServer: startHttpServerMock }))
vi.mock('../daemon/daemon-registry.js', () => ({
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

// isDirectEntryPoint gates the auto-invoked `main()` at module load; it is
// false under vitest (argv1 is the test runner, not this file), so importing
// this module never triggers the top-level `main().catch(...)` path — tests
// call the exported `main` directly instead.
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

describe('server/index main() daemon mode data dir threading', () => {
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
    process.argv = [...originalArgv, '--daemon']
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
    process.argv = [...originalArgv, '--daemon']
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

describe('server/index main() WHITEBOARD_ALLOWED_WEB_ORIGINS startup gate', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    delete process.env.WHITEBOARD_ALLOWED_WEB_ORIGINS
  })

  it('aborts before startHttpServer and logs a structured record on an invalid env value', async () => {
    process.env.WHITEBOARD_ALLOWED_WEB_ORIGINS = 'not a url'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const capture = captureLogsForTests('debug')
    try {
      await expect(main()).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(startHttpServerMock).not.toHaveBeenCalled()
      const record = capture.records.find(
        (r) => r.scope === 'web-origin-allowlist' && r.level === 'error',
      )
      expect(record).toBeDefined()
      expect(JSON.stringify(record)).not.toContain('not a url')
    } finally {
      capture.restore()
      exitSpy.mockRestore()
    }
  })

  it('refuses to start when an allowlist is set but no auth token is provided', async () => {
    process.env.WHITEBOARD_ALLOWED_WEB_ORIGINS = 'https://kamiazya-whiteboard.pages.dev'
    delete process.env.WHITEBOARD_TOKEN
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
    } finally {
      capture.restore()
      exitSpy.mockRestore()
    }
  })

  it('threads a valid allowlist through to startHttpServer and never exits', async () => {
    process.env.WHITEBOARD_ALLOWED_WEB_ORIGINS = 'https://kamiazya-whiteboard.pages.dev'
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(startHttpServerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedWebOrigins: ['https://kamiazya-whiteboard.pages.dev'],
        }),
      )
    } finally {
      exitSpy.mockRestore()
      stdoutSpy.mockRestore()
      delete process.env.WHITEBOARD_TOKEN
    }
  })
})

describe('server/index main() WHITEBOARD_OAUTH_CLIENT_REGISTRY startup gate', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    delete process.env.WHITEBOARD_OAUTH_CLIENT_REGISTRY
    delete process.env.WHITEBOARD_TOKEN
  })

  it('aborts before startHttpServer and logs a structured record on an invalid env value', async () => {
    process.env.WHITEBOARD_OAUTH_CLIENT_REGISTRY = 'not json'
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
    } finally {
      capture.restore()
      exitSpy.mockRestore()
    }
  })

  it('threads a valid registry through to startHttpServer and never exits', async () => {
    const registry = [{ clientId: 'test-client', redirectUris: ['https://example.com/callback'] }]
    process.env.WHITEBOARD_OAUTH_CLIENT_REGISTRY = JSON.stringify(registry)
    process.env.WHITEBOARD_TOKEN = 'test-token'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(startHttpServerMock).toHaveBeenCalledWith(
        expect.objectContaining({ oauthClientRegistry: registry }),
      )
    } finally {
      exitSpy.mockRestore()
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
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ port: 'not-a-number' }))

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

  it('drops the default hosted-origin admission on a tokenless start instead of refusing', async () => {
    delete process.env.WHITEBOARD_TOKEN
    delete process.env.WHITEBOARD_ALLOWED_WEB_ORIGINS

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const capture = captureLogsForTests()
    try {
      await main()
      expect(startHttpServerMock).toHaveBeenCalledWith(
        expect.objectContaining({ allowedWebOrigins: [] }),
      )
      const notice = capture.records.find(
        (r) =>
          r.scope === 'server-index' && r.msg.includes('default hosted-origin admission disabled'),
      )
      expect(notice).toBeDefined()
    } finally {
      capture.restore()
      stdoutSpy.mockRestore()
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
