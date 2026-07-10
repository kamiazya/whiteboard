import { describe, expect, it, vi } from 'vitest'
import {
  DAEMON_STARTUP_CONTENTION_TOKEN,
  isDaemonStartupContentionError,
  retryDaemonStartup,
} from './daemon-readiness.js'

describe('isDaemonStartupContentionError', () => {
  it('matches the ensure-daemon.ts startup timeout message', () => {
    expect(isDaemonStartupContentionError(new Error('Daemon startup timeout'))).toBe(true)
  })

  it('matches the daemon-lock.ts startup lock timeout message', () => {
    expect(isDaemonStartupContentionError(new Error('Daemon startup lock timeout'))).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isDaemonStartupContentionError(new Error('some other tool error'))).toBe(false)
    expect(isDaemonStartupContentionError(new Error('RPC tools/call (#3) timed out'))).toBe(false)
  })

  it('the centralized token still matches both known production messages', () => {
    expect('Daemon startup timeout'.includes(DAEMON_STARTUP_CONTENTION_TOKEN)).toBe(true)
    expect('Daemon startup lock timeout'.includes(DAEMON_STARTUP_CONTENTION_TOKEN)).toBe(true)
  })
})

describe('retryDaemonStartup', () => {
  it('recovers when attempt() eventually succeeds within the retry ceiling', async () => {
    let calls = 0
    const attempt = vi.fn(async () => {
      calls++
      if (calls <= 2) throw new Error('Daemon startup timeout')
      return 'ready'
    })
    const sleep = vi.fn(async () => {})

    const result = await retryDaemonStartup({ attempt, maxRetries: 2, sleep })

    expect(result).toBe('ready')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('succeeds exactly at the retry ceiling boundary', async () => {
    let calls = 0
    const attempt = vi.fn(async () => {
      calls++
      if (calls <= 1) throw new Error('Daemon startup lock timeout')
      return 'ready'
    })

    const result = await retryDaemonStartup({ attempt, maxRetries: 1, sleep: async () => {} })

    expect(result).toBe('ready')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('rejects with a distinct exhausted-retries message when the budget runs out', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('Daemon startup timeout')
    })

    await expect(
      retryDaemonStartup({ attempt, maxRetries: 1, sleep: async () => {} }),
    ).rejects.toThrow(/retry budget exhausted after 2 attempts/)
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('fails immediately on a non-startup-contention error, without retrying', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('unexpected tool/call result shape: {}')
    })

    await expect(
      retryDaemonStartup({ attempt, maxRetries: 3, sleep: async () => {} }),
    ).rejects.toThrow('unexpected tool/call result shape: {}')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('uses no real timers when sleep is not provided', async () => {
    let calls = 0
    const attempt = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('Daemon startup timeout')
      return 'ready'
    })

    const result = await retryDaemonStartup({ attempt, maxRetries: 1 })

    expect(result).toBe('ready')
  })
})
