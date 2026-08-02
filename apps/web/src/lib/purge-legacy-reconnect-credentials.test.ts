import { afterEach, describe, expect, it, vi } from 'vitest'
import { purgeLegacyReconnectCredentials } from './purge-legacy-reconnect-credentials.js'

const LEGACY_KEY = 'whiteboard.reconnect-secret.v1'

afterEach(() => {
  localStorage.clear()
})

describe('purgeLegacyReconnectCredentials', () => {
  it('removes the legacy reconnect secret key', () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ origin: 'http://localhost:3099', secret: 'x' }),
    )

    purgeLegacyReconnectCredentials()

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('leaves unrelated localStorage keys untouched', () => {
    localStorage.setItem('some.other.key', 'keep-me')
    localStorage.setItem(LEGACY_KEY, 'stale-secret')

    purgeLegacyReconnectCredentials()

    expect(localStorage.getItem('some.other.key')).toBe('keep-me')
  })

  it('is idempotent — a second call is a no-op', () => {
    localStorage.setItem(LEGACY_KEY, 'stale-secret')

    purgeLegacyReconnectCredentials()
    expect(() => purgeLegacyReconnectCredentials()).not.toThrow()
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('never throws when localStorage.removeItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    expect(() => purgeLegacyReconnectCredentials()).not.toThrow()

    spy.mockRestore()
  })

  it('is a no-op when nothing was ever stored', () => {
    expect(() => purgeLegacyReconnectCredentials()).not.toThrow()
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })
})
