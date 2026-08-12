import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensurePersistentStorage, queryPersistentStorage } from './persistent-storage.js'

// jsdom has no navigator.storage — define/restore it per test.
function withStorage(impl: Partial<StorageManager> | undefined) {
  Object.defineProperty(navigator, 'storage', {
    value: impl,
    configurable: true,
  })
}

afterEach(() => {
  withStorage(undefined)
})

describe('ensurePersistentStorage', () => {
  it('requests persistence once and reports the grant', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    withStorage({ persist, persisted: vi.fn().mockResolvedValue(false) })
    await expect(ensurePersistentStorage()).resolves.toBe(true)
    expect(persist).toHaveBeenCalled()
  })

  it('skips the request when persistence is already granted', async () => {
    const persist = vi.fn()
    withStorage({ persist, persisted: vi.fn().mockResolvedValue(true) })
    await expect(ensurePersistentStorage()).resolves.toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('reports a denial as false, not a throw', async () => {
    withStorage({
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    })
    await expect(ensurePersistentStorage()).resolves.toBe(false)
  })

  it('returns null where the API is unavailable', async () => {
    withStorage(undefined)
    await expect(ensurePersistentStorage()).resolves.toBeNull()
    await expect(queryPersistentStorage()).resolves.toBeNull()
  })
})
