import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureLogsForTests } from '../server/log.js'
import { getDataDir, resetDataDirForTests } from '../shared/data-dir-secure.js'

const { createServerSpy } = vi.hoisted(() => ({ createServerSpy: vi.fn() }))

// Partial mock: keep the real node:net surface (BlockList etc. used elsewhere in
// the import graph) and override only createServer.
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:net')>()
  return { ...real, createServer: createServerSpy }
})

const { loadDaemonRecordMock, startHttpServerMock } = vi.hoisted(() => ({
  loadDaemonRecordMock: vi.fn(async () => null),
  startHttpServerMock: vi.fn(async () => ({
    port: 3099,
    close: vi.fn(async () => undefined),
    touch: vi.fn(),
    getRuntimeStatus: vi.fn(),
  })),
}))

vi.mock('../daemon/daemon-registry.js', () => ({
  loadDaemonRecord: loadDaemonRecordMock,
  saveDaemonRecord: vi.fn(async () => undefined),
  deleteDaemonRecord: vi.fn(async () => undefined),
  isPidAlive: vi.fn(() => false),
}))

vi.mock('../server/http-server.js', () => ({
  startHttpServer: startHttpServerMock,
}))

const { findAvailablePort, runDaemonRun } = await import('./daemon-run.js')

// A minimal net.Server stand-in: EventEmitter for .on()/.emit() plus the
// listen/close/address surface findAvailablePort touches. Mocking createServer
// drives the 'error' path deterministically without binding real ports, which is
// flaky under parallel runs and restricted CI sandboxes.
function fakeServer(opts: { errorCode?: string; port?: number }) {
  const server = new EventEmitter() as EventEmitter & {
    listen: (port: number, host: string, cb: () => void) => void
    close: (cb?: () => void) => void
    address: () => { port: number }
  }
  server.listen = (_port, _host, cb) => {
    queueMicrotask(() => {
      if (opts.errorCode) {
        server.emit('error', Object.assign(new Error(opts.errorCode), { code: opts.errorCode }))
      } else {
        cb()
      }
    })
  }
  server.close = (cb?: () => void) => cb?.()
  server.address = () => ({ port: opts.port ?? 0 })
  return server
}

describe('findAvailablePort', () => {
  afterEach(() => vi.clearAllMocks())

  it('rejects immediately on a non-EADDRINUSE error and does not scan further ports', async () => {
    createServerSpy.mockImplementation(() => fakeServer({ errorCode: 'EACCES' }))
    await expect(findAvailablePort(4000)).rejects.toMatchObject({ code: 'EACCES' })
    // A permanent error must stop the scan at the first port, not walk ~62k ports.
    expect(createServerSpy).toHaveBeenCalledTimes(1)
  })

  it('retries the next port on EADDRINUSE until one binds', async () => {
    let call = 0
    createServerSpy.mockImplementation(() => {
      call += 1
      return call === 1 ? fakeServer({ errorCode: 'EADDRINUSE' }) : fakeServer({ port: 5005 })
    })
    await expect(findAvailablePort(5004)).resolves.toBe(5005)
    expect(createServerSpy).toHaveBeenCalledTimes(2)
  })
})

describe('runDaemonRun bind-host guard', () => {
  afterEach(() => vi.clearAllMocks())

  it.each([
    '0.0.0.0',
    '192.168.1.5',
    'evil.example',
  ])('refuses to start the daemon bound to non-loopback host %s and never calls startHttpServer', async (host) => {
    const outcome = await runDaemonRun({ host, tokenStdin: false, dataDir: '/tmp/whiteboard-test' })
    expect(outcome.kind).toBe('refused')
    expect(startHttpServerMock).not.toHaveBeenCalled()
  })

  it.each([
    '127.0.0.1',
    'localhost',
    '::1',
  ])('starts the daemon when bound to loopback host %s', async (host) => {
    const outcome = await runDaemonRun({ host, tokenStdin: false, dataDir: '/tmp/whiteboard-test' })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalled()
  })
})

describe('runDaemonRun WHITEBOARD_ALLOWED_WEB_ORIGINS wiring', () => {
  afterEach(() => vi.clearAllMocks())

  it('fails fast with a structured outcome and logs an error record on an invalid env value', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const outcome = await runDaemonRun({
        host: '127.0.0.1',
        tokenStdin: false,
        dataDir: '/tmp/whiteboard-test',
        env: { WHITEBOARD_ALLOWED_WEB_ORIGINS: 'not a url' },
      })
      expect(outcome).toEqual({
        kind: 'input-error',
        message: expect.stringContaining('WHITEBOARD_ALLOWED_WEB_ORIGINS'),
        code: 'invalid_allowed_web_origins',
      })
      expect(startHttpServerMock).not.toHaveBeenCalled()
      const record = capture.records.find(
        (r) => r.scope === 'web-origin-allowlist' && r.level === 'error',
      )
      expect(record).toBeDefined()
    } finally {
      capture.restore()
    }
  })

  it('threads a valid allowlist through to startHttpServer', async () => {
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: { WHITEBOARD_ALLOWED_WEB_ORIGINS: 'https://kamiazya-whiteboard.pages.dev' },
    })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedWebOrigins: ['https://kamiazya-whiteboard.pages.dev'],
      }),
    )
  })

  it('defaults to an empty allowlist when the env var is unset', async () => {
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: {},
    })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowedWebOrigins: [] }),
    )
  })
})

describe('runDaemonRun --data-dir storage redirection', () => {
  afterEach(() => {
    resetDataDirForTests()
    startHttpServerMock.mockClear()
  })

  it('redirects the shared data-dir seam so all storage follows the explicit dataDir', async () => {
    const dir = join(tmpdir(), `daemon-run-datadir-${Date.now()}`)
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      port: 3099,
      dataDir: dir,
      env: { WHITEBOARD_DAEMON_TOKEN: 'seam-test-token' },
    })
    expect(outcome.kind).toBe('running')
    expect(getDataDir()).toBe(resolve(dir))
  })

  it('leaves the seam untouched when no dataDir option is given', async () => {
    const before = getDataDir()
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      port: 3099,
      env: { WHITEBOARD_DAEMON_TOKEN: 'seam-test-token' },
    })
    expect(outcome.kind).toBe('running')
    expect(getDataDir()).toBe(before)
  })
})

describe('runDaemonRun token source conflict', () => {
  afterEach(() => vi.clearAllMocks())

  it('rejects with an input-error and never starts the daemon when --token-stdin and WHITEBOARD_DAEMON_TOKEN are both set', async () => {
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      tokenStdin: true,
      dataDir: '/tmp/whiteboard-test',
      env: { WHITEBOARD_DAEMON_TOKEN: 'env-token-should-never-leak' },
    })
    expect(outcome.kind).toBe('input-error')
    if (outcome.kind === 'input-error') {
      expect(outcome.code).toBe('token_source_conflict')
      expect(outcome.message).not.toContain('env-token-should-never-leak')
    }
    expect(startHttpServerMock).not.toHaveBeenCalled()
  })

  it('still uses the env token when only WHITEBOARD_DAEMON_TOKEN is set (no --token-stdin)', async () => {
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: { WHITEBOARD_DAEMON_TOKEN: 'env-only-token' },
    })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'env-only-token' }),
    )
  })

  it('still reads the token from stdin when only --token-stdin is set (no env token)', async () => {
    const fakeStdin = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
    fakeStdin.setEncoding = vi.fn()
    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
    try {
      const outcomePromise = runDaemonRun({
        host: '127.0.0.1',
        tokenStdin: true,
        dataDir: '/tmp/whiteboard-test',
        env: {},
      })
      queueMicrotask(() => {
        fakeStdin.emit('data', 'stdin-only-token\n')
        fakeStdin.emit('end')
      })
      const outcome = await outcomePromise
      expect(outcome.kind).toBe('running')
      expect(startHttpServerMock).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'stdin-only-token' }),
      )
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
    }
  })
})

describe('runDaemonRun WHITEBOARD_OAUTH_CLIENT_REGISTRY wiring', () => {
  afterEach(() => vi.clearAllMocks())

  it('fails fast with a structured outcome on an invalid env value and never calls startHttpServer', async () => {
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: { WHITEBOARD_OAUTH_CLIENT_REGISTRY: 'not json' },
    })
    expect(outcome).toEqual({
      kind: 'input-error',
      message: expect.stringContaining('WHITEBOARD_OAUTH_CLIENT_REGISTRY'),
      code: 'invalid_oauth_client_registry',
    })
    expect(startHttpServerMock).not.toHaveBeenCalled()
  })

  it('threads a valid registry through to startHttpServer', async () => {
    const registry = [{ clientId: 'test-client', redirectUris: ['https://example.com/callback'] }]
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: { WHITEBOARD_OAUTH_CLIENT_REGISTRY: JSON.stringify(registry) },
    })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ oauthClientRegistry: registry }),
    )
  })

  it('defaults to an empty registry when the env var is unset', async () => {
    const outcome = await runDaemonRun({
      host: '127.0.0.1',
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: {},
    })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ oauthClientRegistry: [] }),
    )
  })
})
