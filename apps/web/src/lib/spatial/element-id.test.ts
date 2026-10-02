// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCreateId } from './element-id.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('defaultCreateId without crypto.randomUUID', () => {
  it('falls back to 32 lowercase hex digits from getRandomValues', () => {
    // An insecure context (plain http on a LAN) has no randomUUID.
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => array.fill(0x0a),
    })
    expect(defaultCreateId()).toBe('0a'.repeat(16))
  })
})
