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

  it('never fires onIdle when the timeout is disabled via a non-positive sentinel', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const timer = new IdleTimer(0, onIdle)

    timer.start()
    // Advance well past what would be a real dev daemon's 15-minute default,
    // to prove disablement isn't just "a longer wait" but permanent.
    vi.advanceTimersByTime(60 * 60_000)
    expect(onIdle).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('never fires onIdle when touch() is called after the timeout was disabled', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const timer = new IdleTimer(0, onIdle)

    timer.start()
    vi.advanceTimersByTime(30 * 60_000)
    timer.touch()
    vi.advanceTimersByTime(30 * 60_000)
    expect(onIdle).not.toHaveBeenCalled()
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
