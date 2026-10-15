import { describe, expect, it, vi } from 'vitest'
import { FILE_GC_STOP_TIMEOUT_MS } from '../shared/stop-timeouts.js'

// loadDaemonRecord is a hard import in daemon-stop.ts and is not injectable
// via options. Mock the registry module so each test controls what record
// is returned without touching the filesystem.
const { loadDaemonRecordMock } = vi.hoisted(() => ({
  loadDaemonRecordMock:
    vi.fn<
      (
        dataDir: string,
        seams?: unknown,
      ) => Promise<null | {
        pid: number
        port: number
        version: string
        startedAt: string
        token: string
        socketPath?: string
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
const { answeringDaemonSocket } = await import('../daemon/_test-daemon-socket.js')

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
    // Every fake pid here is the daemon; a real /proc entry under the same
    // number must not decide it.
    processStartMs: () => null,
    killFn: () => undefined,
    sleep: async () => undefined,
    stopTimeoutMs: 0,
    killWaitMs: 0,
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

// The close the daemon runs on SIGTERM can wait the whole file-sweeper cap
// before the rest of shutdown (listener, flush) even starts. A default window
// of exactly that cap SIGKILLs a daemon that is still stopping cleanly, so the
// window is read off the default path — nothing here passes `stopTimeoutMs`.
describe('runDaemonStop: the default SIGTERM window', () => {
  it('outlasts the file sweeper stop cap before it escalates to SIGKILL', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      let killedAfterMs: number | null = null
      await runDaemonStop({
        dataDir: '/fake',
        processStartMs: () => null,
        isPidAlive: () => true,
        killFn: (_pid, signal) => {
          if (signal === 'SIGKILL') killedAfterMs = Date.now() - startedAt
        },
        sleep: async (ms) => {
          vi.advanceTimersByTime(ms)
        },
        killWaitMs: 0,
        removeRecord: async () => undefined,
      })
      expect(killedAfterMs).not.toBeNull()
      expect(killedAfterMs as unknown as number).toBeGreaterThan(FILE_GC_STOP_TIMEOUT_MS)
    } finally {
      vi.useRealTimers()
    }
  })
})

// After SIGKILL the process only has to be reaped, so the wait is short. It is
// still a bound: a process that never goes (an uninterruptible one) must not
// hold the command past it. Read off the default path — nothing here passes
// `killWaitMs`.
describe('runDaemonStop: the default wait after SIGKILL', () => {
  it('gives up on a process that stays alive after 200 ms', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)
    vi.useFakeTimers()
    try {
      let killedAt: number | null = null
      const { exitCode } = await runDaemonStop({
        dataDir: '/fake',
        processStartMs: () => null,
        isPidAlive: () => true,
        killFn: (_pid, signal) => {
          if (signal === 'SIGKILL') killedAt = Date.now()
        },
        sleep: async (ms) => {
          vi.advanceTimersByTime(ms)
        },
        stopTimeoutMs: 0,
        removeRecord: async () => undefined,
      })

      expect(killedAt).not.toBeNull()
      expect(Date.now() - (killedAt as unknown as number)).toBe(200)
      expect(exitCode).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// daemon.json outlives a daemon that died without closing (SIGKILL, OOM, power
// loss), and after a reboot its pid can belong to any process of this user. A
// process that started after the record was written did not write it.
describe('runDaemonStop: a stale record whose pid another process took', () => {
  const recordedAtMs = Date.parse(fakeRecord.startedAt)

  it('signals nothing, reports the daemon not running, and drops the record', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)
    const killFn = vi.fn()
    const removeRecord = vi.fn(async () => undefined)
    const { result, exitCode } = await runDaemonStop(
      baseOpts({
        isPidAlive: () => true,
        processStartMs: () => recordedAtMs + 60_000,
        killFn,
        removeRecord,
      }),
    )
    expect(killFn).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, action: 'not-running', reason: 'pid-reused' })
    expect(exitCode).toBe(1)
    expect(removeRecord).toHaveBeenCalledWith('/fake')
  })

  it('withholds SIGKILL from a pid another process took during the SIGTERM window', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)
    const signals: string[] = []
    const starts = [recordedAtMs - 1_000, recordedAtMs + 60_000]
    await runDaemonStop(
      baseOpts({
        isPidAlive: () => true,
        processStartMs: () => starts.shift() ?? recordedAtMs + 60_000,
        killFn: (_pid, signal) => {
          signals.push(signal)
        },
      }),
    )
    expect(signals).toEqual(['SIGTERM'])
  })

  it('still stops a process that started before its record was written', async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(fakeRecord)
    const killFn = vi.fn()
    const { result } = await runDaemonStop(
      baseOpts({
        isPidAlive: () => true,
        processStartMs: () => recordedAtMs - 1_000,
        killFn,
      }),
    )
    expect(killFn).toHaveBeenCalledWith(fakeRecord.pid, 'SIGTERM')
    expect(killFn).toHaveBeenCalledWith(fakeRecord.pid, 'SIGKILL')
    expect(result.action).toBe('stopped')
  })
})

// /proc/stat's btime moves with a stepped wall clock while a process's start
// ticks do not, so after a forward step of a few seconds the daemon itself
// reads as having started after its own record. Its socket still answers.
describe('runDaemonStop: a live daemon after the wall clock stepped forward', () => {
  const recordedAtMs = Date.parse(fakeRecord.startedAt)
  const steppedStart = () => recordedAtMs + 6_000

  it('stops the daemon its socket confirms rather than dropping its record', async () => {
    const daemon = await answeringDaemonSocket(fakeRecord.pid, fakeRecord.token)
    loadDaemonRecordMock.mockResolvedValueOnce({ ...fakeRecord, socketPath: daemon.socketPath })
    const killFn = vi.fn()
    const alive = [true, false]
    const { result, exitCode } = await runDaemonStop(
      baseOpts({
        isPidAlive: () => alive.shift() ?? false,
        processStartMs: steppedStart,
        stopTimeoutMs: 1_000,
        killFn,
      }),
    )
    expect(result).toMatchObject({ ok: true, action: 'stopped', reason: null })
    expect(killFn).toHaveBeenCalledWith(fakeRecord.pid, 'SIGTERM')
    expect(exitCode).toBe(0)
  })

  it('keeps the record and signals nothing when the socket answers for another pid', async () => {
    const daemon = await answeringDaemonSocket(fakeRecord.pid + 1, fakeRecord.token)
    loadDaemonRecordMock.mockResolvedValueOnce({ ...fakeRecord, socketPath: daemon.socketPath })
    const killFn = vi.fn()
    const removeRecord = vi.fn(async () => undefined)
    const { result, exitCode } = await runDaemonStop(
      baseOpts({ isPidAlive: () => true, processStartMs: steppedStart, killFn, removeRecord }),
    )
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      action: 'refused',
      reason: 'identity-unconfirmed',
      pid: fakeRecord.pid,
      servingPid: fakeRecord.pid + 1,
    })
    expect(killFn).not.toHaveBeenCalled()
    expect(removeRecord).not.toHaveBeenCalled()
    expect(exitCode).toBe(1)
  })
})

// The record is read through the same liveness question the stop then asks,
// so a test's process seams must reach the read as well.
describe('runDaemonStop: reading the record', () => {
  it("passes the caller's process seams to the record's reader", async () => {
    loadDaemonRecordMock.mockResolvedValueOnce(null)
    const isPidAlive = () => false
    const processStartMs = () => null
    await runDaemonStop(baseOpts({ isPidAlive, processStartMs }))
    expect(loadDaemonRecordMock).toHaveBeenCalledWith('/fake', {
      isAlive: isPidAlive,
      startMs: processStartMs,
    })
  })
})
