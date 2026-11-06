// A body laid out under one UI mode must never be served to another, and a
// cache filled under one reference wire is dropped when the wire changes.
import { describe, expect, it } from 'vitest'
import { createContentCacheStore } from './layout-content-caches.js'

describe('the layout worker content-cache store', () => {
  it('keeps one cache per UI mode across requests', () => {
    const cacheFor = createContentCacheStore()
    const light = cacheFor({ theme: 'light', wireKey: 'null' })
    expect(cacheFor({ theme: 'light', wireKey: 'null' })).toBe(light)
    expect(cacheFor({ theme: 'dark', wireKey: 'null' })).not.toBe(light)
  })

  it('drops a cache when the reference wire changes', () => {
    const cacheFor = createContentCacheStore()
    const light = cacheFor({ theme: 'light', wireKey: 'null' })
    expect(cacheFor({ theme: 'light', wireKey: '{"a":1}' })).not.toBe(light)
  })
})
