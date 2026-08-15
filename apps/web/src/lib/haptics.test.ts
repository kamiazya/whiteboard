import { afterEach, describe, expect, it, vi } from 'vitest'
import { hapticTick } from './haptics.js'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('hapticTick', () => {
  it('uses the Vibration API where it exists', () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    hapticTick()
    expect(vibrate).toHaveBeenCalledWith(10)
    // No fallback element when the real API answered.
    expect(document.querySelector('input[switch]')).toBeNull()
  })

  it('falls back to the iOS switch-toggle tick, reusing one hidden element', () => {
    vi.stubGlobal('navigator', {})
    hapticTick()
    const input = document.querySelector('input[switch]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.getAttribute('type')).toBe('checkbox')
    expect(input.closest('label')?.getAttribute('aria-hidden')).toBe('true')
    const before = input.checked
    hapticTick()
    // The same element toggles again rather than accumulating clones.
    expect(document.querySelectorAll('input[switch]')).toHaveLength(1)
    expect(input.checked).toBe(!before)
  })

  it('never throws when there is nothing to vibrate with', () => {
    vi.stubGlobal('navigator', undefined)
    expect(() => hapticTick()).not.toThrow()
  })
})
