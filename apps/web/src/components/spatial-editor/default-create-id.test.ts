// @vitest-environment jsdom
/**
 * `defaultCreateId` under each shape of `crypto` a real browser hands it.
 *
 * The middle case is the one that matters and the one nothing covered:
 * `crypto.randomUUID` is **secure-context only**, and this app is reached
 * over plain http on a LAN by design (Local Network Access is a feature
 * here). So a real user hits the fallback, and before this it was
 * `String(Math.random())` — while `crypto.getRandomValues`, which carries
 * no such restriction, was sitting right there.
 *
 * The DOM lib declares `randomUUID` required on `Crypto`, which is why the
 * implementation reads through a view that admits it may be absent; these
 * cases are what proves that view is about reality rather than taste.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCreateId } from '../../lib/spatial/element-id.js'

const realCrypto = globalThis.crypto

function withCrypto(value: unknown) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true })
}
afterEach(() => withCrypto(realCrypto))

describe('defaultCreateId', () => {
  it('uses randomUUID in a secure context', () => {
    const randomUUID = vi.fn(() => '11111111-2222-3333-4444-555555555555')
    withCrypto({ randomUUID, getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })

    expect(defaultCreateId()).toBe('11111111-2222-3333-4444-555555555555')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('falls back to getRandomValues where randomUUID is absent, not to Math.random', () => {
    // An insecure context: LAN http, which this app supports.
    const getRandomValues = vi.fn((array: Uint8Array) => {
      array.fill(0xab)
      return array
    })
    withCrypto({ getRandomValues })

    const id = defaultCreateId()
    expect(getRandomValues).toHaveBeenCalledTimes(1)
    expect(id).toBe('ab'.repeat(16))
    // Not a float rendered as a string, which is what it used to be.
    expect(id).not.toContain('.')
  })

  it('still answers something when the runtime has no crypto at all', () => {
    withCrypto(undefined)
    const id = defaultCreateId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('does not repeat itself', () => {
    withCrypto(realCrypto)
    const ids = new Set(Array.from({ length: 200 }, () => defaultCreateId()))
    expect(ids.size).toBe(200)
  })
})
