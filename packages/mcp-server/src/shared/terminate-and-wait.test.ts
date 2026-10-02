import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminateAndWait } from './terminate-and-wait.js'

const PID = 4242

/** A process that dies `lifetimeMs` after the clock starts, on the fake clock. */
function dyingAt(lifetimeMs: number): () => boolean {
  const born = Date.now()
  return () => Date.now() - born < lifetimeMs
}

function harness(overrides: Partial<Parameters<typeof terminateAndWait>[0]> = {}) {
  const signals: Array<{ signal: string; at: number }> = []
  const slept: number[] = []
  const start = Date.now()
  const options: Parameters<typeof terminateAndWait>[0] = {
    pid: PID,
    isAlive: () => true,
    kill: (_pid, signal) => {
      signals.push({ signal, at: Date.now() - start })
    },
    sleep: (ms) => {
      slept.push(ms)
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
    timeoutMs: 1000,
    pollMs: 100,
    killWaitMs: 200,
    ...overrides,
  }
  return { options, signals, slept }
}

describe('terminateAndWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends SIGTERM only when the process exits inside the window', async () => {
    const { options, signals } = harness({ isAlive: dyingAt(350) })
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toEqual({ kind: 'exited' })
    expect(signals).toEqual([{ signal: 'SIGTERM', at: 0 }])
  })

  it('falls back to SIGKILL once the window lapses, and not before', async () => {
    const { options, signals } = harness()
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(999)
    await expect(Promise.race([pending, 'still-waiting'])).resolves.toBe('still-waiting')
    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toEqual({ kind: 'killed' })
    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(signals[1]?.at).toBe(1000)
  })

  it('never sleeps past the deadline', async () => {
    const { options, slept } = harness({ timeoutMs: 250, killWaitMs: 0 })
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(slept).toEqual([100, 100, 50])
  })

  it('stops waiting after SIGKILL as soon as the process is gone', async () => {
    const { options, signals, slept } = harness({
      timeoutMs: 100,
      killWaitMs: 5000,
      isAlive: dyingAt(150),
    })
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ kind: 'killed' })
    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThan(500)
  })

  it('does not wait after SIGKILL when killWaitMs is 0', async () => {
    const { options, slept } = harness({ timeoutMs: 100, killWaitMs: 0 })
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(slept.reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('withholds SIGKILL when confirmKill says the pid is no longer ours', async () => {
    const { options, signals } = harness({ confirmKill: async () => false })
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toEqual({ kind: 'kill-withheld' })
    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM'])
  })

  it('does not ask confirmKill when SIGTERM was enough', async () => {
    const confirmKill = vi.fn(async () => true)
    const { options } = harness({ isAlive: dyingAt(100), confirmKill })
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(confirmKill).not.toHaveBeenCalled()
  })

  it('answers a SIGTERM that cannot be sent, with the error, before any waiting', async () => {
    const error = Object.assign(new Error('no such process'), { code: 'ESRCH' })
    const { options, slept } = harness({
      kill: () => {
        throw error
      },
    })
    await expect(terminateAndWait(options)).resolves.toEqual({ kind: 'signal-failed', error })
    expect(slept).toEqual([])
  })

  it('treats a SIGKILL that throws as the process already being gone', async () => {
    const kill = vi.fn((_pid: number, signal: string) => {
      if (signal === 'SIGKILL') throw new Error('gone')
    })
    const { options } = harness({ kill, timeoutMs: 100 })
    const pending = terminateAndWait(options)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toEqual({ kind: 'killed' })
  })
})
