import { afterEach, describe, expect, it } from 'vitest'
import { readDaemonTokenOnce, resetTokenStoreForTests, seedDaemonToken } from './token-store.js'

function setWindow(value: unknown): void {
  ;(globalThis as { window?: unknown }).window = value
}

function deleteWindow(): void {
  delete (globalThis as { window?: unknown }).window
}

describe('token-store', () => {
  afterEach(() => {
    resetTokenStoreForTests()
    deleteWindow()
  })

  it('returns the token when window.__WHITEBOARD_DAEMON_TOKEN__ is set and deletes the global', () => {
    setWindow({ __WHITEBOARD_DAEMON_TOKEN__: 'seeded-token' })
    expect(readDaemonTokenOnce()).toBe('seeded-token')
    expect(
      (globalThis as { window?: { __WHITEBOARD_DAEMON_TOKEN__?: unknown } }).window
        ?.__WHITEBOARD_DAEMON_TOKEN__,
    ).toBeUndefined()
  })

  it('still returns the token when the global is non-configurable (delete throws in strict mode)', () => {
    const win: Record<string, unknown> = {}
    Object.defineProperty(win, '__WHITEBOARD_DAEMON_TOKEN__', {
      value: 'pinned-token',
      configurable: false,
      writable: false,
    })
    setWindow(win)
    expect(readDaemonTokenOnce()).toBe('pinned-token')
    // The scrub failed (property is non-configurable) but reads still work.
    expect(readDaemonTokenOnce()).toBe('pinned-token')
  })

  it('returns null when the global is absent', () => {
    setWindow({})
    expect(readDaemonTokenOnce()).toBeNull()
  })

  it('one-shot semantics: stays null even if the global appears after the first (null) read', () => {
    setWindow({})
    expect(readDaemonTokenOnce()).toBeNull()
    setWindow({ __WHITEBOARD_DAEMON_TOKEN__: 'too-late' })
    expect(readDaemonTokenOnce()).toBeNull()
  })

  it('second call returns the stored value with the global already deleted', () => {
    setWindow({ __WHITEBOARD_DAEMON_TOKEN__: 'seeded-token' })
    expect(readDaemonTokenOnce()).toBe('seeded-token')
    expect(readDaemonTokenOnce()).toBe('seeded-token')
  })

  it('non-string global value falls back to null without throwing', () => {
    setWindow({ __WHITEBOARD_DAEMON_TOKEN__: 42 })
    expect(() => readDaemonTokenOnce()).not.toThrow()
    expect(readDaemonTokenOnce()).toBeNull()
  })

  it('no window (Node/server context) returns null without throwing', () => {
    deleteWindow()
    expect(() => readDaemonTokenOnce()).not.toThrow()
    expect(readDaemonTokenOnce()).toBeNull()
  })

  it('seedDaemonToken makes readDaemonTokenOnce return the seeded token with no window global', () => {
    deleteWindow()
    seedDaemonToken('silent-reconnect-token')
    expect(readDaemonTokenOnce()).toBe('silent-reconnect-token')
  })

  it('seedDaemonToken does not clobber a token already consumed from the fragment global', () => {
    setWindow({ __WHITEBOARD_DAEMON_TOKEN__: 'fragment-token' })
    expect(readDaemonTokenOnce()).toBe('fragment-token')
    seedDaemonToken('reconnect-token')
    expect(readDaemonTokenOnce()).toBe('fragment-token')
  })

  it('seedDaemonToken installs a token after an earlier fragment-free read already consumed the one-shot slot', () => {
    // Reproduces App.tsx's real mount order: readDaemonTokenOnce() always
    // runs once on mount (lazy useState initializer), even when there is no
    // #wb= fragment. A silent-reconnect redemption that resolves afterward
    // must still be able to seed its token — otherwise DaemonBackend.
    // openSocket's direct read of this store silently gets null forever.
    setWindow({})
    expect(readDaemonTokenOnce()).toBeNull()
    seedDaemonToken('reconnect-token')
    expect(readDaemonTokenOnce()).toBe('reconnect-token')
  })

  it('resetTokenStoreForTests restores first-read semantics between tests', () => {
    setWindow({ __WHITEBOARD_DAEMON_TOKEN__: 'first' })
    expect(readDaemonTokenOnce()).toBe('first')
    resetTokenStoreForTests()
    setWindow({ __WHITEBOARD_DAEMON_TOKEN__: 'second' })
    expect(readDaemonTokenOnce()).toBe('second')
  })
})
