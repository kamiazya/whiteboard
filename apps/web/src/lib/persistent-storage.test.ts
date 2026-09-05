// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePersistentStorage,
  queryPersistentStorage,
  queryStorageEstimate,
} from './persistent-storage.js'

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

describe('queryStorageEstimate', () => {
  it('reports usage and quota as bytes', async () => {
    withStorage({ estimate: vi.fn().mockResolvedValue({ usage: 42, quota: 1024 }) })
    await expect(queryStorageEstimate()).resolves.toEqual({ usageBytes: 42, quotaBytes: 1024 })
  })

  it('returns null where the API is unavailable', async () => {
    withStorage(undefined)
    await expect(queryStorageEstimate()).resolves.toBeNull()
  })

  it('returns null when the browser answers without numbers', async () => {
    // StorageEstimate's fields are both optional in the spec.
    withStorage({ estimate: vi.fn().mockResolvedValue({}) })
    await expect(queryStorageEstimate()).resolves.toBeNull()
  })

  it('reports a throwing estimate as null, not a crash', async () => {
    withStorage({ estimate: vi.fn().mockRejectedValue(new Error('denied')) })
    await expect(queryStorageEstimate()).resolves.toBeNull()
  })
})
