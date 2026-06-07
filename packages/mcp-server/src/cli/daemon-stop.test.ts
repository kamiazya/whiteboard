import { describe, expect, it, vi } from 'vitest'

// loadDaemonRecord is a hard import in daemon-stop.ts and is not injectable
// via options. Mock the registry module so each test controls what record
// is returned without touching the filesystem.
const { loadDaemonRecordMock } = vi.hoisted(() => ({
  loadDaemonRecordMock:
    vi.fn<
      () => Promise<null | {
        pid: number
        port: number
        version: string
        startedAt: string
        token: string
      }>
    >(),
}))

vi.mock('../daemon/daemon-registry.js', () => ({
  loadDaemonRecord: loadDaemonRecordMock,
  // deleteDaemonRecord is used as default removeRecord — supply a no-op.
  deleteDaemonRecord: vi.fn(async () => undefined),
  isPidAlive: vi.fn(() => false),
}))

const { runDaemonStop } = await import('./daemon-stop.js')

const fakeRecord = {
  pid: 12345,
  port: 3099,
  version: '1.0.0',
  startedAt: '2024-01-01T00:00:00.000Z',
  token: 'tok',
}

// Convenience builders for injected options.
function baseOpts(
  overrides: Partial<Parameters<typeof runDaemonStop>[0]> = {},
): Parameters<typeof runDaemonStop>[0] {
  return {
    dataDir: '/fake',
    isPidAlive: () => false,
    killFn: () => undefined,
    sleep: async () => undefined,
    stopTimeoutMs: 0,
    removeRecord: async () => undefined,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// record not found
// ---------------------------------------------------------------------------

describe('runDaemonStop: record not found', () => {
  it('returns exitCode 1, ok=false, action=not-running, reason=record-not-found', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(null)

    const { result, exitCode } = await runDaemonStop(baseOpts())

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.action).toBe('not-running')
    expect(result.reason).toBe('record-not-found')
    expect(result.pid).toBeNull()
    expect(result.schemaVersion).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// record found but process already dead
// ---------------------------------------------------------------------------

describe('runDaemonStop: process not running', () => {
  it('returns exitCode 1, action=not-running, reason=process-not-running', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)
    const removeRecord = vi.fn(async () => undefined)

    const { result, exitCode } = await runDaemonStop(
      baseOpts({
        isPidAlive: () => false,
        removeRecord,
      }),
    )

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.action).toBe('not-running')
    expect(result.reason).toBe('process-not-running')
    expect(result.pid).toBe(fakeRecord.pid)
  })

  it('removes the stale record when process is dead', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)
    const removeRecord = vi.fn(async () => undefined)

    await runDaemonStop(baseOpts({ isPidAlive: () => false, removeRecord }))

    expect(removeRecord).toHaveBeenCalledOnce()
    expect(removeRecord).toHaveBeenCalledWith('/fake')
  })
})

// ---------------------------------------------------------------------------
// process alive → kill succeeds → stopped
// ---------------------------------------------------------------------------

describe('runDaemonStop: process alive → stopped', () => {
  it('returns exitCode 0, ok=true, action=stopped when SIGTERM succeeds', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)

    let aliveCallCount = 0
    // Pre-kill check: alive. Poll loop: dead immediately.
    const isPidAlive = () => {
      aliveCallCount += 1
      return aliveCallCount === 1
    }
    const killFn = vi.fn()
    const removeRecord = vi.fn(async () => undefined)

    const { result, exitCode } = await runDaemonStop(
      baseOpts({ isPidAlive, killFn, removeRecord, stopTimeoutMs: 500 }),
    )

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('stopped')
    expect(result.reason).toBeNull()
    expect(result.pid).toBe(fakeRecord.pid)
  })

  it('sends SIGTERM to the process pid', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)

    let aliveCallCount = 0
    const isPidAlive = () => {
      aliveCallCount += 1
      return aliveCallCount === 1
    }
    const killFn = vi.fn()

    await runDaemonStop(baseOpts({ isPidAlive, killFn, stopTimeoutMs: 100 }))

    expect(killFn).toHaveBeenCalledWith(fakeRecord.pid, 'SIGTERM')
  })

  it('removes the record after stopping', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)

    let aliveCallCount = 0
    const isPidAlive = () => {
      aliveCallCount += 1
      return aliveCallCount === 1
    }
    const removeRecord = vi.fn(async () => undefined)

    await runDaemonStop(baseOpts({ isPidAlive, killFn: vi.fn(), removeRecord, stopTimeoutMs: 100 }))

    expect(removeRecord).toHaveBeenCalledWith('/fake')
  })
})

// ---------------------------------------------------------------------------
// kill throws → refused
// ---------------------------------------------------------------------------

describe('runDaemonStop: kill fails', () => {
  it('returns exitCode 1, ok=false, action=refused, reason=kill-failed', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)

    const killFn = vi.fn(() => {
      throw new Error('EPERM')
    })

    const { result, exitCode } = await runDaemonStop(
      baseOpts({
        isPidAlive: () => true,
        killFn,
      }),
    )

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.action).toBe('refused')
    expect(result.reason).toBe('kill-failed')
    expect(result.pid).toBe(fakeRecord.pid)
  })
})

// ---------------------------------------------------------------------------
// process survives SIGTERM → SIGKILL escalation
// ---------------------------------------------------------------------------

describe('runDaemonStop: process survives SIGTERM → SIGKILL', () => {
  it('sends SIGKILL when process does not die within the timeout', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)

    // Process stays alive throughout (simulates stubborn daemon).
    const isPidAlive = vi.fn(() => true)
    const killFn = vi.fn()
    const sleep = vi.fn(async () => undefined)
    const removeRecord = vi.fn(async () => undefined)

    await runDaemonStop(
      baseOpts({
        isPidAlive,
        killFn,
        sleep,
        stopTimeoutMs: 0,
        removeRecord,
      }),
    )

    // SIGTERM first, then SIGKILL
    expect(killFn).toHaveBeenCalledWith(fakeRecord.pid, 'SIGTERM')
    expect(killFn).toHaveBeenCalledWith(fakeRecord.pid, 'SIGKILL')
  })

  it('still removes the record after SIGKILL escalation', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)

    const killFn = vi.fn()
    const removeRecord = vi.fn(async () => undefined)

    await runDaemonStop(
      baseOpts({
        isPidAlive: () => true,
        killFn,
        sleep: async () => undefined,
        stopTimeoutMs: 0,
        removeRecord,
      }),
    )

    expect(removeRecord).toHaveBeenCalledWith('/fake')
  })
})
