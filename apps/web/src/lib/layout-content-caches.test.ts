// A body laid out under one look must never be served to another: the
// session override is an axis of what a layout request MEANS, so it is an
// axis of the store the worker answers it from.
import { describe, expect, it } from 'vitest'
import { createContentCacheStore } from './layout-content-caches.js'

describe('the layout worker content-cache store', () => {
  it('gives each look its own cache, and keeps each look its own', () => {
    const cacheFor = createContentCacheStore()
    const clean = cacheFor({ theme: 'light', style: 'clean', wireKey: 'null' })
    const drawn = cacheFor({ theme: 'light', style: 'document', wireKey: 'null' })
    expect(clean).not.toBe(drawn)
    expect(cacheFor({ theme: 'light', style: 'clean', wireKey: 'null' })).toBe(clean)
    expect(cacheFor({ theme: 'light', style: 'visual.neon', wireKey: 'null' })).not.toBe(drawn)
  })

  it('treats an absent style as the document look both threads default to', () => {
    const cacheFor = createContentCacheStore()
    const implied = cacheFor({ theme: 'light', wireKey: 'null' })
    expect(cacheFor({ theme: 'light', style: 'document', wireKey: 'null' })).toBe(implied)
  })

  it('still separates the UI modes and drops a cache when the reference wire changes', () => {
    const cacheFor = createContentCacheStore()
    const light = cacheFor({ theme: 'light', style: 'document', wireKey: 'null' })
    expect(cacheFor({ theme: 'dark', style: 'document', wireKey: 'null' })).not.toBe(light)
    expect(cacheFor({ theme: 'light', style: 'document', wireKey: '{"a":1}' })).not.toBe(light)
  })
})
