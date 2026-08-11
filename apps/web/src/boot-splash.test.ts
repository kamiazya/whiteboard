import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissBootSplash,
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

describe('dismissBootSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"><div class="wb-boot"></div></div>'
  })
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
