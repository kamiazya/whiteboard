import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissBootSplash,
  elapsedSinceFirstPaint,
  SPLASH_FADE_MS,
  SPLASH_MIN_VISIBLE_MS,
  splashHoldMs,
} from './boot-splash.js'

describe('splashHoldMs', () => {
  it('holds out to the minimum visible time', () => {
    expect(splashHoldMs(400, false)).toBe(SPLASH_MIN_VISIBLE_MS - 400)
  })

  it('does not hold once the minimum has already elapsed (slow load)', () => {
    expect(splashHoldMs(SPLASH_MIN_VISIBLE_MS + 1, false)).toBe(0)
  })

  it('never holds under reduced motion', () => {
    expect(splashHoldMs(0, true)).toBe(0)
  })
})

describe('elapsedSinceFirstPaint', () => {
  afterEach(() => vi.restoreAllMocks())

  // A slow HTML fetch delays first paint past the time origin; the clock
  // must start when the splash became visible, not when navigation began.
  it('measures from first-contentful-paint, not the time origin', () => {
    vi.spyOn(performance, 'now').mockReturnValue(2000)
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: 'first-contentful-paint', startTime: 1800 } as PerformanceEntry,
    ])
    expect(elapsedSinceFirstPaint()).toBe(200)
  })

  it('falls back to the time origin when no paint entry exists', () => {
    vi.spyOn(performance, 'now').mockReturnValue(700)
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([])
    expect(elapsedSinceFirstPaint()).toBe(700)
  })
})

describe('dismissBootSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"><div class="wb-boot"></div></div>'
  })
  // biome-ignore lint/plugin: boot splash DOM predates React; nothing mounts a root here
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('waits out the hold, fades the splash, then resolves', async () => {
    let resolved = false
    const p = dismissBootSplash({ elapsedMs: 100, reducedMotion: false }).then(() => {
      resolved = true
    })
    const splash = document.querySelector('.wb-boot') as HTMLElement

    // Mid-hold: splash untouched, promise pending.
    await vi.advanceTimersByTimeAsync(SPLASH_MIN_VISIBLE_MS - 100 - 1)
    expect(splash.style.opacity).toBe('')
    expect(resolved).toBe(false)

    // Hold over: fade begins but the promise waits for the fade.
    await vi.advanceTimersByTimeAsync(1)
    expect(splash.style.opacity).toBe('0')
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(SPLASH_FADE_MS)
    await p
    expect(resolved).toBe(true)
  })

  it('resolves immediately under reduced motion, leaving the splash unfaded', async () => {
    const p = dismissBootSplash({ elapsedMs: 0, reducedMotion: true })
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect((document.querySelector('.wb-boot') as HTMLElement).style.opacity).toBe('')
  })

  it('tolerates a missing splash element (already replaced)', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    const p = dismissBootSplash({ elapsedMs: SPLASH_MIN_VISIBLE_MS, reducedMotion: false })
    await vi.advanceTimersByTimeAsync(0)
    await expect(p).resolves.toBeUndefined()
  })
})
