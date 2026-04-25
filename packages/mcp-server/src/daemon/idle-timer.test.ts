import { describe, expect, it, vi } from 'vitest'
import { IdleTimer } from './idle-timer.js'

describe('IdleTimer', () => {
  it('fires onIdle after the timeout with no activity', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const timer = new IdleTimer(1_000, onIdle)

    timer.start()
    vi.advanceTimersByTime(999)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('resets the countdown on touch', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const timer = new IdleTimer(1_000, onIdle)

    timer.start()
    vi.advanceTimersByTime(600)
    timer.touch()
    vi.advanceTimersByTime(600)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(400)
    expect(onIdle).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('reports elapsed idle time from the last activity', () => {
    vi.useFakeTimers()
    const timer = new IdleTimer(1_000, vi.fn())

    timer.start()
    vi.advanceTimersByTime(250)
    expect(timer.getIdleForMs()).toBe(250)

    timer.touch()
    vi.advanceTimersByTime(125)
    expect(timer.getIdleForMs()).toBe(125)
    vi.useRealTimers()
  })
})
