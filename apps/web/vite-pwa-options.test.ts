import { describe, expect, it } from 'vitest'
import { pwaOptions } from './vite-pwa-options.js'

describe('pwaOptions', () => {
  it('uses prompt-based updates (never silently swap a mid-draw canvas)', () => {
    expect(pwaOptions.registerType).toBe('prompt')
  })

  it('denylists same-origin daemon/API route prefixes from navigateFallback', () => {
    const denylist = pwaOptions.workbox?.navigateFallbackDenylist ?? []
    expect(denylist.length).toBeGreaterThan(0)

    const positiveCases = ['/api/canvases', '/mcp', '/ws']
    for (const path of positiveCases) {
      expect(denylist.some((re) => re.test(path))).toBe(true)
    }

    const negativeCases = ['/', '/canvas/abc']
    for (const path of negativeCases) {
      expect(denylist.some((re) => re.test(path))).toBe(false)
    }
  })

  it('never registers runtime caching, so the SW cannot intercept daemon/LNA traffic', () => {
    const runtimeCaching = pwaOptions.workbox?.runtimeCaching
    expect(runtimeCaching === undefined || runtimeCaching.length === 0).toBe(true)
  })

  it('raises the precache size ceiling so the entry chunk is not silently dropped', () => {
    expect(pwaOptions.workbox?.maximumFileSizeToCacheInBytes).toBeGreaterThanOrEqual(
      4 * 1024 * 1024,
    )
  })

  it('precaches the app shell: entry assets, Excalidraw fonts, and icons', () => {
    const patterns = pwaOptions.workbox?.globPatterns ?? []
    expect(patterns.some((p) => p.includes('woff2'))).toBe(true)
    expect(patterns.some((p) => p.includes('png'))).toBe(true)
  })

  it('locks the web manifest fields consumed by installability', () => {
    const manifest = pwaOptions.manifest
    if (manifest === false) throw new Error('manifest must not be disabled')
    expect(manifest.name).toBe('Whiteboard')
    expect(manifest.short_name).toBe('Whiteboard')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')

    const icons = manifest.icons ?? []
    const sizes = icons.map((icon) => icon.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    for (const icon of icons) {
      expect(icon.purpose).toBe('any maskable')
    }
  })
})
