import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDataDir, resetDataDirForTests } from '../shared/data-dir-secure.js'

const { loadDaemonRecordMock, startHttpServerMock } = vi.hoisted(() => ({
  loadDaemonRecordMock: vi.fn(async () => null),
  startHttpServerMock: vi.fn(async () => ({
    socketPath: '/run/user/1000/whiteboard/d.sock',
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

const { runDaemonRun } = await import('./daemon-run.js')
const { LOCAL_DAEMON_TAIL_INTERVAL_MS, resolveWorkspaceTailIntervalMs } = await import(
  '../server/store/workspace-tail.js'
)

describe('runDaemonRun listens on its socket alone', () => {
  afterEach(() => vi.clearAllMocks())

  // ADR-0050: the local daemon listens on no TCP port. What a caller learns
  // is the socket, and the daemon is never handed a port or host to bind.
  it('reports the socket in the ready JSON and hands the server no port or host', async () => {
    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: {},
    })
    if (outcome.kind !== 'running') throw new Error(`expected running, got ${outcome.kind}`)
    expect(outcome.result.socketPath).toBe('/run/user/1000/whiteboard/d.sock')
    expect(outcome.result).not.toHaveProperty('port')
    expect(outcome.result).not.toHaveProperty('host')
    const [options] = startHttpServerMock.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(options).not.toHaveProperty('port')
    expect(options).not.toHaveProperty('host')
    expect(typeof options.socketPath).toBe('string')
  })
})

describe('runDaemonRun WHITEBOARD_REPLICA_TIER wiring', () => {
  afterEach(() => vi.clearAllMocks())

  // Regression: this CLI path (`whiteboard daemon run`) used to skip
  // collectStartupEnvIssues entirely, so an invalid WHITEBOARD_REPLICA_TIER
  // started the daemon silently instead of aborting — unlike server/index.ts's
  // dev entrypoint, which already gated on it.
  it('fails fast with a structured outcome on an invalid value and never starts the daemon', async () => {
    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: { WHITEBOARD_REPLICA_TIER: 'Offline' },
    })
    expect(outcome).toEqual({
      kind: 'input-error',
      message: expect.stringContaining('WHITEBOARD_REPLICA_TIER'),
      code: 'startup_env',
    })
    expect(startHttpServerMock).not.toHaveBeenCalled()
  })

  it('threads a valid override through to startHttpServer', async () => {
    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: { WHITEBOARD_REPLICA_TIER: 'no-offline' },
    })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ replicaTier: 'no-offline' }),
    )
  })

  it('defaults to offline when the env var is unset', async () => {
    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: {},
    })
    expect(outcome.kind).toBe('running')
    expect(startHttpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ replicaTier: 'offline' }),
    )
  })
})

describe('runDaemonRun arms the workspace tail', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  // The agent's stdio process writes the same record this daemon serves, and
  // only the tail carries what it wrote to a browser that is just watching.
  it('defaults the interval for the daemon it starts', async () => {
    vi.stubEnv('WHITEBOARD_WORKSPACE_TAIL_MS', undefined)
    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
      env: {},
    })
    expect(outcome.kind).toBe('running')
    expect(resolveWorkspaceTailIntervalMs()).toBe(LOCAL_DAEMON_TAIL_INTERVAL_MS)
  })

  it('keeps an interval the operator chose, and does not arm one they turned off', async () => {
    vi.stubEnv('WHITEBOARD_WORKSPACE_TAIL_MS', '2000')
    await runDaemonRun({ tokenStdin: false, dataDir: '/tmp/whiteboard-test', env: {} })
    expect(resolveWorkspaceTailIntervalMs()).toBe(2000)

    vi.stubEnv('WHITEBOARD_WORKSPACE_TAIL_MS', '0')
    await runDaemonRun({ tokenStdin: false, dataDir: '/tmp/whiteboard-test', env: {} })
    expect(resolveWorkspaceTailIntervalMs()).toBeNull()
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
      tokenStdin: false,
      dataDir: dir,
      env: { WHITEBOARD_DAEMON_TOKEN: 'seam-test-token' },
    })
    expect(outcome.kind).toBe('running')
    expect(getDataDir()).toBe(resolve(dir))
  })

  it('hands the registry the resolved-absolute dir even when --data-dir is relative', async (ctx) => {
    // A relative --data-dir resolves against cwd, and runDaemonRun creates it.
    // Pointing at `./something` would therefore plant a directory in whatever
    // cwd the suite runs from — the repo root — and because the daemon never
    // writes into it, the empty dir is invisible to `git status` and just
    // accumulates. Aim the relative path at a temp dir instead: still
    // relative, so it still exercises the resolve(), but nothing lands here.
    const absolute = join(tmpdir(), `daemon-run-rel-${Date.now()}`)
    const rel = relative(process.cwd(), absolute)
    // No relative path exists between two volumes, and path.relative() answers
    // with an absolute one instead — reachable on Windows when TEMP sits on a
    // different drive than the checkout. The case this test pins is then
    // unreachable, so skip rather than assert something false about the
    // platform; the containment rule below is what must hold either way.
    if (isAbsolute(rel)) ctx.skip()
    expect(resolve(rel).startsWith(process.cwd())).toBe(false)
    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: rel,
      env: { WHITEBOARD_DAEMON_TOKEN: 'seam-test-token' },
    })
    expect(outcome.kind).toBe('running')
    expect(getDataDir()).toBe(resolve(rel))
    const registry = await import('../daemon/daemon-registry.js')
    const saveMock = vi.mocked(registry.saveDaemonRecord)
    expect(saveMock.mock.calls.at(-1)?.[1]).toBe(resolve(rel))
  })

  it('leaves the seam untouched when no dataDir option is given', async () => {
    const before = getDataDir()
    const outcome = await runDaemonRun({
      tokenStdin: false,
      env: { WHITEBOARD_DAEMON_TOKEN: 'seam-test-token' },
    })
    expect(outcome.kind).toBe('running')
    expect(getDataDir()).toBe(before)
  })
})

describe('runDaemonRun legacy reconnect trust-file purge', () => {
  afterEach(() => {
    resetDataDirForTests()
    startHttpServerMock.mockClear()
  })

  it('removes a planted trusted-web-origins.json from the data dir on startup', async () => {
    const fs = await import('node:fs/promises')
    const dir = join(tmpdir(), `daemon-run-purge-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const trustFile = join(dir, 'trusted-web-origins.json')
    await fs.writeFile(trustFile, '{"schemaVersion":2,"origins":[]}')

    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: dir,
      env: { WHITEBOARD_DAEMON_TOKEN: 'seam-test-token' },
    })

    expect(outcome.kind).toBe('running')
    await expect(fs.readFile(trustFile, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns its normal running outcome even when the purge itself rejects unexpectedly', async () => {
    const purgeModule = await import('../server/purge-legacy-trust-file.js')
    const spy = vi
      .spyOn(purgeModule, 'purgeLegacyWebOriginTrustFile')
      .mockRejectedValueOnce(new Error('purge exploded'))
    try {
      const dir = join(tmpdir(), `daemon-run-purge-fail-${Date.now()}`)
      // Startup-totality property: an unexpected purge rejection (beyond the
      // ENOENT/permission cases the function already swallows internally)
      // must not change runDaemonRun's outcome — it can only add a log line.
      const outcome = await runDaemonRun({
        tokenStdin: false,
        dataDir: dir,
        env: { WHITEBOARD_DAEMON_TOKEN: 'seam-test-token' },
      })
      expect(outcome.kind).toBe('running')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('runDaemonRun token source conflict', () => {
  afterEach(() => vi.clearAllMocks())

  it('rejects with an input-error and never starts the daemon when --token-stdin and WHITEBOARD_DAEMON_TOKEN are both set', async () => {
    const outcome = await runDaemonRun({
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
      // Wait for the real 'data' listener to attach before emitting: the
      // startup path now awaits an async purge step ahead of the stdin
      // read, so a fire-immediately queueMicrotask() can race ahead of
      // readTokenFromStdin()'s listener registration and drop the event.
      const listenerAttached = new Promise<void>((resolve) => {
        fakeStdin.once('newListener', (event) => {
          if (event === 'data') resolve()
        })
      })
      const outcomePromise = runDaemonRun({
        tokenStdin: true,
        dataDir: '/tmp/whiteboard-test',
        env: {},
      })
      await listenerAttached
      fakeStdin.emit('data', 'stdin-only-token\n')
      fakeStdin.emit('end')
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

describe('runDaemonRun when the server closes itself', () => {
  it('an idle close removes the daemon record and settles the run as idle', async () => {
    const registry = await import('../daemon/daemon-registry.js')
    vi.mocked(registry.deleteDaemonRecord).mockClear()
    startHttpServerMock.mockClear()
    const outcome = await runDaemonRun({
      tokenStdin: false,
      dataDir: '/tmp/whiteboard-test',
    })
    if (outcome.kind !== 'running') throw new Error(`expected running, got ${outcome.kind}`)
    // The idle timer's close runs the server's onClose; nothing signalled.
    const [options] = startHttpServerMock.mock.calls[0] as unknown as [
      { onClose?: () => Promise<void> },
    ]
    await options.onClose?.()
    await expect(outcome.stopped).resolves.toBe('idle')
    expect(registry.deleteDaemonRecord).toHaveBeenCalledWith(getDataDir())
  })
})
