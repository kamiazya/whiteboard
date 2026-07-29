import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const loadDaemonRecordMock = vi.fn()
const deleteDaemonRecordMock = vi.fn()
const isPidAliveMock = vi.fn()
const withDaemonStartupLockMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

vi.mock('./daemon-registry.js', () => ({
  loadDaemonRecord: loadDaemonRecordMock,
  deleteDaemonRecord: deleteDaemonRecordMock,
  isPidAlive: isPidAliveMock,
}))

vi.mock('./daemon-lock.js', () => ({
  withDaemonStartupLock: withDaemonStartupLockMock,
}))

vi.mock('../shared/data-dir-secure.js', () => ({
  DATA_DIR: '/tmp/excalidraw-data',
  WHITEBOARD_ROOT: '/repo/packages/mcp-server',
}))

const { ensureDaemon } = await import('./ensure-daemon.js')

describe('ensureDaemon', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetAllMocks()
    withDaemonStartupLockMock.mockImplementation(
      async (_dataDir: string, fn: () => Promise<unknown>) => fn(),
    )
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reuses an existing healthy daemon record', async () => {
    loadDaemonRecordMock.mockResolvedValue({
      pid: 42,
      port: 3099,
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    })
    isPidAliveMock.mockReturnValue(true)
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as typeof globalThis.fetch

    const result = await ensureDaemon({ dataDir: '/tmp/excalidraw-data' })

    expect(result).toMatchObject({
      pid: 42,
      port: 3099,
      token: 'secret',
      baseUrl: 'http://127.0.0.1:3099',
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(deleteDaemonRecordMock).not.toHaveBeenCalled()
  })

  it('spawns a new daemon when the registry is stale and returns the saved record', async () => {
    loadDaemonRecordMock
      .mockResolvedValueOnce({
        pid: 10,
        port: 3099,
        token: 'old-token',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        pid: 777,
        port: 45001,
        token: 'new-token',
        version: '0.1.0',
        startedAt: '2026-04-23T00:05:00.000Z',
      })
    isPidAliveMock.mockReturnValue(false)
    spawnMock.mockReturnValue({
      pid: 777,
      unref: vi.fn(),
    })
    let polls = 0
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      polls += 1
      expect(url.toString()).toBe('http://127.0.0.1:45001/api/runtime/ping')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof globalThis.fetch

    const result = await ensureDaemon({
      dataDir: '/tmp/excalidraw-data',
      startPort: 45001,
      startupTimeoutMs: 500,
    })

    expect(deleteDaemonRecordMock).toHaveBeenCalledWith('/tmp/excalidraw-data')
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      pid: 777,
      port: 45001,
      token: 'new-token',
      baseUrl: 'http://127.0.0.1:45001',
    })
    expect(polls).toBeGreaterThan(0)
  })

  it('uses node --watch + tsx/esm in dev mode so server changes restart without restarting the MCP session', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      pid: 888,
      port: 45002,
      token: 'watch-token',
      version: '0.1.0',
      startedAt: '2026-04-23T00:05:00.000Z',
    })
    spawnMock.mockReturnValue({
      pid: 888,
      unref: vi.fn(),
    })
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as typeof globalThis.fetch

    await ensureDaemon({
      dataDir: '/tmp/excalidraw-data',
      env: { WHITEBOARD_DEV: '1' },
      startPort: 45002,
      startupTimeoutMs: 500,
    })

    expect(spawnMock).toHaveBeenCalledOnce()
    const [command, args] = spawnMock.mock.calls[0]
    expect(command).toBe('node')
    expect(args).toContain('--watch')
    expect(args).toContain('--import')
    expect(args).toContain('tsx/esm')
    expect(args).toContain('/repo/packages/mcp-server/src/server/index.ts')
    expect(args).toContain('--daemon')
    expect(args).toContain('--port=45002')
  })

  it('re-checks the registry after taking the startup lock and reuses a daemon started by another caller', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      pid: 91,
      port: 45100,
      token: 'shared-token',
      version: '0.1.0',
      startedAt: '2026-04-23T00:06:00.000Z',
    })
    isPidAliveMock.mockReturnValue(true)
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as typeof globalThis.fetch

    const result = await ensureDaemon({
      dataDir: '/tmp/excalidraw-data',
      startupTimeoutMs: 500,
    })

    expect(withDaemonStartupLockMock).toHaveBeenCalledOnce()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      pid: 91,
      port: 45100,
      token: 'shared-token',
      baseUrl: 'http://127.0.0.1:45100',
    })
  })

  it('fails fast with a clear bind error when loopback listen is not permitted', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    await expect(
      ensureDaemon({
        dataDir: '/tmp/excalidraw-data',
        startPort: 65536,
        startupTimeoutMs: 500,
      }),
    ).rejects.toThrow(/Invalid daemon startPort/)
  })
})
