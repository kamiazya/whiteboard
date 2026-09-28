import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  DATA_DIR: '/tmp/whiteboard-data',
  WHITEBOARD_ROOT: '/repo/packages/mcp-server',
}))

const { ensureDaemon } = await import('./ensure-daemon.js')

/**
 * A daemon answering on a real socket, the only place the local daemon
 * listens (ADR-0050): ensureDaemon has no port to reach it on.
 */
let dir: string
let daemon: Server | undefined
async function answeringSocket(): Promise<string> {
  const socketPath = join(dir, 'daemon.sock')
  daemon = createServer((req, res) => {
    res.statusCode = req.url === '/api/runtime/ping' ? 200 : 404
    res.end()
  })
  await new Promise<void>((resolve) => daemon?.listen(socketPath, resolve))
  return socketPath
}

function record(overrides: Record<string, unknown>) {
  return {
    pid: 42,
    token: 'secret',
    version: '0.1.0',
    startedAt: '2026-04-23T00:00:00.000Z',
    socketPath: join(dir, 'nobody-listens.sock'),
    ...overrides,
  }
}

describe('ensureDaemon', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'wb-ensure-'))
    withDaemonStartupLockMock.mockImplementation(
      async (_dataDir: string, fn: () => Promise<unknown>) => fn(),
    )
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()))
    daemon = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('reuses a daemon that answers on the socket its record names', async () => {
    const socketPath = await answeringSocket()
    loadDaemonRecordMock.mockResolvedValue(record({ socketPath }))
    isPidAliveMock.mockReturnValue(true)

    const result = await ensureDaemon({ dataDir: '/tmp/whiteboard-data' })

    expect(result).toMatchObject({ pid: 42, token: 'secret', socketPath })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(deleteDaemonRecordMock).not.toHaveBeenCalled()
  })

  it('spawns a new daemon when the registry is stale and returns the record it writes', async () => {
    const socketPath = await answeringSocket()
    loadDaemonRecordMock
      .mockResolvedValueOnce(record({ pid: 10, token: 'old-token' }))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(record({ pid: 777, token: 'new-token', socketPath }))
    isPidAliveMock.mockImplementation((pid: number) => pid === 777)
    spawnMock.mockReturnValue({ pid: 777, unref: vi.fn() })

    const result = await ensureDaemon({ dataDir: '/tmp/whiteboard-data', startupTimeoutMs: 2_000 })

    expect(deleteDaemonRecordMock).toHaveBeenCalledWith('/tmp/whiteboard-data')
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ pid: 777, token: 'new-token', socketPath })
  })

  it('spawns the daemon with no port and no host to bind', async () => {
    const socketPath = await answeringSocket()
    loadDaemonRecordMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(record({ pid: 888, socketPath }))
    isPidAliveMock.mockReturnValue(true)
    spawnMock.mockReturnValue({ pid: 888, unref: vi.fn() })

    await ensureDaemon({ dataDir: '/tmp/whiteboard-data', startupTimeoutMs: 2_000 })

    const [, args] = spawnMock.mock.calls[0]
    expect(args.some((arg: string) => arg.startsWith('--port'))).toBe(false)
    expect(args.some((arg: string) => arg.startsWith('--host'))).toBe(false)
  })

  it('uses node --watch + tsx/esm in dev mode so server changes restart without restarting the MCP session', async () => {
    const socketPath = await answeringSocket()
    loadDaemonRecordMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(record({ pid: 888, socketPath }))
    isPidAliveMock.mockReturnValue(true)
    spawnMock.mockReturnValue({ pid: 888, unref: vi.fn() })

    await ensureDaemon({
      dataDir: '/tmp/whiteboard-data',
      env: { WHITEBOARD_DEV: '1' },
      startupTimeoutMs: 2_000,
    })

    expect(spawnMock).toHaveBeenCalledOnce()
    const [command, args] = spawnMock.mock.calls[0]
    expect(command).toBe('node')
    expect(args).toContain('--watch')
    expect(args).toContain('--import')
    expect(args).toContain('tsx/esm')
    expect(args).toContain('/repo/packages/mcp-server/src/server/daemon-entry.ts')
  })

  it('omits --watch in dev mode when WHITEBOARD_NO_WATCH is set to avoid EMFILE on fd-heavy machines', async () => {
    const socketPath = await answeringSocket()
    loadDaemonRecordMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(record({ pid: 889, socketPath }))
    isPidAliveMock.mockReturnValue(true)
    spawnMock.mockReturnValue({ pid: 889, unref: vi.fn() })

    await ensureDaemon({
      dataDir: '/tmp/whiteboard-data',
      env: { WHITEBOARD_DEV: '1', WHITEBOARD_NO_WATCH: '1' },
      startupTimeoutMs: 2_000,
    })

    const [command, args] = spawnMock.mock.calls[0]
    expect(command).toBe('node')
    expect(args).not.toContain('--watch')
    expect(args).toContain('/repo/packages/mcp-server/src/server/daemon-entry.ts')
  })

  // The daemon token is a full-authority bearer credential. On Linux
  // /proc/<pid>/cmdline is world-readable by default (hidepid=0), while
  // /proc/<pid>/environ is 0400 owner-only — and argv additionally reaches
  // every `ps aux`, monitoring agent, and pasted bug report. The CLI surface
  // already refuses `--token` for this reason (cli/argv.ts); this is the
  // auto-spawn path, which does not go through that parser.
  it.each([
    ['packaged', {} as NodeJS.ProcessEnv],
    ['dev', { WHITEBOARD_DEV: '1' } as NodeJS.ProcessEnv],
  ])('never puts the daemon token on the spawned argv (%s mode)', async (_label, env) => {
    const socketPath = await answeringSocket()
    loadDaemonRecordMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(record({ pid: 890, socketPath }))
    isPidAliveMock.mockReturnValue(true)
    spawnMock.mockReturnValue({ pid: 890, unref: vi.fn() })

    await ensureDaemon({ dataDir: '/tmp/whiteboard-data', env, startupTimeoutMs: 2_000 })

    expect(spawnMock).toHaveBeenCalledOnce()
    const [, args, options] = spawnMock.mock.calls[0]

    // The token travels in the environment instead, where the spawned
    // daemon's resolveToken() reads it as WHITEBOARD_TOKEN.
    const token = options?.env?.WHITEBOARD_TOKEN
    expect(typeof token).toBe('string')
    expect(token).not.toBe('')

    // Assert on the VALUE, not only the flag name: a differently-spelled
    // flag carrying the same secret would be the same leak.
    expect(args.some((arg: string) => arg.includes(token as string))).toBe(false)
    expect(args.some((arg: string) => arg.startsWith('--token'))).toBe(false)
  })

  it('re-checks the registry after taking the startup lock and reuses a daemon started by another caller', async () => {
    const socketPath = await answeringSocket()
    loadDaemonRecordMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(record({ pid: 91, token: 'shared-token', socketPath }))
    isPidAliveMock.mockReturnValue(true)

    const result = await ensureDaemon({ dataDir: '/tmp/whiteboard-data', startupTimeoutMs: 500 })

    expect(withDaemonStartupLockMock).toHaveBeenCalledOnce()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ pid: 91, token: 'shared-token', socketPath })
  })

  it('gives up with the startup-timeout error when the spawned daemon never answers', async () => {
    loadDaemonRecordMock.mockResolvedValue(null)
    spawnMock.mockReturnValue({ pid: 999, unref: vi.fn() })

    await expect(
      ensureDaemon({ dataDir: '/tmp/whiteboard-data', startupTimeoutMs: 200 }),
    ).rejects.toThrow('Daemon startup timeout')
  })
})
