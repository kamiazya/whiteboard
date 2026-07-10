import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from './log.js'

const { startHttpServerMock } = vi.hoisted(() => ({
  startHttpServerMock: vi.fn(async () => ({
    port: 3099,
    getRuntimeStatus: () => ({ startedAt: '2026-01-01T00:00:00.000Z' }),
  })),
}))

vi.mock('./http-server.js', () => ({ startHttpServer: startHttpServerMock }))
vi.mock('../daemon/daemon-registry.js', () => ({
  saveDaemonRecord: vi.fn(async () => undefined),
  deleteDaemonRecord: vi.fn(async () => undefined),
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
