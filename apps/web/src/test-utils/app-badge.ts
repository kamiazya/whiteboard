import { type Mock, vi } from 'vitest'

/**
 * A Badging API on `navigator` for one test: `set` and `clear` are the spies
 * the page's badge calls reach. Defined `configurable` and removed by
 * `restore` (or put back, where `navigator` already had its own), so a test
 * leaves no stale spy on `navigator` for the rest of its file.
 */
export function stubAppBadge(): {
  set: Mock<() => Promise<void>>
  clear: Mock<() => Promise<void>>
  restore: () => void
} {
  const set = vi.fn(() => Promise.resolve())
  const clear = vi.fn(() => Promise.resolve())
  const restoreSet = stubOwn('setAppBadge', set)
  const restoreClear = stubOwn('clearAppBadge', clear)
  return {
    set,
    clear,
    restore: () => {
      restoreSet()
      restoreClear()
    },
  }
}

// Puts back an own property the stub shadowed, and removes only one it added.
function stubOwn(name: 'setAppBadge' | 'clearAppBadge', value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, name)
  Object.defineProperty(navigator, name, { value, configurable: true })
  return () => {
    if (original) Object.defineProperty(navigator, name, original)
    else Reflect.deleteProperty(navigator, name)
  }
}
