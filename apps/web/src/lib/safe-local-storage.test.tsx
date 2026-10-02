import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeGetItem, safeRemoveItem, safeSetItem } from './safe-local-storage.js'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('safe-local-storage', () => {
  it('round-trips a value and removes it', () => {
    safeSetItem('k', 'v')
    expect(safeGetItem('k')).toBe('v')
    safeRemoveItem('k')
    expect(safeGetItem('k')).toBeNull()
  })

  it('answers null for a key nothing wrote', () => {
    expect(safeGetItem('absent')).toBeNull()
  })

  it('degrades a storage that throws on every call to an empty one, and never throws', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)
    expect(safeGetItem('k')).toBeNull()
    expect(() => safeSetItem('k', 'v')).not.toThrow()
    expect(() => safeRemoveItem('k')).not.toThrow()
  })

  it('degrades a storage whose accessor itself throws', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(safeGetItem('k')).toBeNull()
    expect(() => safeSetItem('k', 'v')).not.toThrow()
    expect(() => safeRemoveItem('k')).not.toThrow()
  })
})
