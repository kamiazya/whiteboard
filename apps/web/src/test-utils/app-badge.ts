import { type Mock, vi } from 'vitest'

/**
 * A Badging API on `navigator` for one test: `set` and `clear` are the spies
 * the page's badge calls reach. Defined `configurable` and removed by
 * `restore`, so a test that forgets neither leaves a stale spy on
 * `navigator` for the rest of its file.
 */
export function stubAppBadge(): {
  set: Mock<() => Promise<void>>
  clear: Mock<() => Promise<void>>
  restore: () => void
} {
  const set = vi.fn(() => Promise.resolve())
  const clear = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'setAppBadge', { value: set, configurable: true })
  Object.defineProperty(navigator, 'clearAppBadge', { value: clear, configurable: true })
  return {
    set,
    clear,
    restore: () => {
      Reflect.deleteProperty(navigator, 'setAppBadge')
      Reflect.deleteProperty(navigator, 'clearAppBadge')
    },
  }
}
