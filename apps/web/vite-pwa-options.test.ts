import { describe, expect, it } from 'vitest'
import { pwaOptions } from './vite-pwa-options.js'

describe('pwaOptions', () => {
  it('uses prompt-based updates (never silently swap a mid-draw canvas)', () => {
    expect(pwaOptions.registerType).toBe('prompt')
  })

  it('denylists same-origin daemon/API route prefixes from navigateFallback', () => {
    const denylist = pwaOptions.workbox?.navigateFallbackDenylist ?? []
    expect(denylist.length).toBeGreaterThan(0)

    const positiveCases = ['/api/canvases', '/api', '/mcp', '/ws']
    for (const path of positiveCases) {
      expect(denylist.some((re) => re.test(path))).toBe(true)
    }

    const negativeCases = ['/', '/canvas/abc']
    for (const path of negativeCases) {
      expect(denylist.some((re) => re.test(path))).toBe(false)
    }
  })

  it('does not deny the client-side routes added by app-routes.ts — an offline deep link gets the app shell, not a network error', () => {
    const denylist = pwaOptions.workbox?.navigateFallbackDenylist ?? []
    const clientRoutes = ['/canvas/w1/main', '/w/w1', '/local/abc-123']
    for (const path of clientRoutes) {
      expect(denylist.some((re) => re.test(path))).toBe(false)
    }
  })

  it('denylists exact daemon prefixes only, not future routes that merely start with the same characters', () => {
    const denylist = pwaOptions.workbox?.navigateFallbackDenylist ?? []

    // A future client SPA route like /mcpstatus or /workspace must still get
    // the offline app-shell fallback; only the exact /mcp and /ws daemon
    // endpoints (and their sub-paths) are denied.
    const falsePositiveCases = ['/mcpstatus', '/workspace', '/wishlist', '/apikeys']
    for (const path of falsePositiveCases) {
      expect(denylist.some((re) => re.test(path))).toBe(false)
    }

    // Sub-paths of the daemon endpoints must still be denied.
    const truePositiveSubPaths = ['/mcp/tools', '/ws/session']
    for (const path of truePositiveSubPaths) {
      expect(denylist.some((re) => re.test(path))).toBe(true)
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

  it('precaches the app shell: entry assets, the vendored Roboto face, and icons', () => {
    const patterns = pwaOptions.workbox?.globPatterns ?? []
    // The vendored face (packages/canvas-viewer/assets/fonts/Roboto) ships as
    // a .ttf, not .woff2 — without this, an installed offline PWA has no
    // precached font at all and silently falls back to a system face.
    expect(patterns.some((p) => p.includes('ttf'))).toBe(true)
    expect(patterns.some((p) => p.includes('png'))).toBe(true)
  })

  it('precaches the Loro WASM module so the browser-local editor works offline', () => {
    const patterns = pwaOptions.workbox?.globPatterns ?? []
    expect(patterns.some((p) => p.includes('wasm'))).toBe(true)
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

describe('manifest brand alignment', () => {
  it('theme_color matches the app light ground, not the pre-design navy', () => {
    expect(pwaOptions.manifest?.theme_color).toBe('#ffffff')
  })
})

describe('manifest install-surface enrichment', () => {
  it('declares a stable id and focus-existing launch handling', () => {
    expect(pwaOptions.manifest?.id).toBe('/')
    expect(
      (pwaOptions.manifest as { launch_handler?: { client_mode?: string } }).launch_handler
        ?.client_mode,
    ).toBe('focus-existing')
  })

  it('describes itself for the install dialog', () => {
    expect(pwaOptions.manifest?.description?.length ?? 0).toBeGreaterThan(20)
    expect(pwaOptions.manifest?.categories).toContain('productivity')
    expect(pwaOptions.manifest?.screenshots?.[0]).toMatchObject({
      src: '/screenshot-wide.png',
      sizes: '1152x684',
      form_factor: 'wide',
    })
  })

  it('offers a New-canvas shortcut', () => {
    const shortcut = pwaOptions.manifest?.shortcuts?.find((s) => s.name === 'New canvas')
    expect(shortcut?.url).toBe('/?new=canvas')
  })
})
