import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateAppBadge } from './app-badge.js'

function withBadging(
  set: (() => Promise<void>) | undefined,
  clear: (() => Promise<void>) | undefined,
) {
  Object.defineProperty(navigator, 'setAppBadge', { value: set, configurable: true })
  Object.defineProperty(navigator, 'clearAppBadge', { value: clear, configurable: true })
}

afterEach(() => withBadging(undefined, undefined))

describe('updateAppBadge', () => {
  it('shows the dot for unsaved and clears it otherwise', () => {
    const set = vi.fn().mockResolvedValue(undefined)
    const clear = vi.fn().mockResolvedValue(undefined)
    withBadging(set, clear)
    updateAppBadge('unsaved')
    expect(set).toHaveBeenCalledWith()
    updateAppBadge('saved')
    expect(clear).toHaveBeenCalled()
    updateAppBadge('syncing')
    updateAppBadge('offline')
    expect(clear).toHaveBeenCalledTimes(3)
  })

  it('is a no-op where the Badging API is unavailable', () => {
    withBadging(undefined, undefined)
    expect(() => updateAppBadge('unsaved')).not.toThrow()
  })
})
