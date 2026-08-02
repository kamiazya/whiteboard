import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FakeFontFace,
  installFakeFontApis,
  uninstallFakeFontApis,
} from './test-utils/fake-font-face.js'

async function importFreshFontLoading() {
  vi.resetModules()
  return import('./font-loading.js')
}

describe('ensureViewerFontLoaded', () => {
  afterEach(() => {
    vi.useRealTimers()
    uninstallFakeFontApis()
  })

  it('resolves "loaded" once the face finishes loading', async () => {
    const { added } = installFakeFontApis()
    const { ensureViewerFontLoaded } = await importFreshFontLoading()

    const pending = ensureViewerFontLoaded()
    added[0]?.loadDeferred.resolve()

    await expect(pending).resolves.toBe('loaded')
  })

  it('is idempotent: N calls register exactly one face and share one promise', async () => {
    const { added } = installFakeFontApis()
    const { ensureViewerFontLoaded } = await importFreshFontLoading()

    const first = ensureViewerFontLoaded()
    const second = ensureViewerFontLoaded()
    expect(first).toBe(second)
    added[0]?.loadDeferred.resolve()
    await first

    const third = ensureViewerFontLoaded()
    expect(third).toBe(first)
    expect(added).toHaveLength(1)
  })

  it('resolves "degraded" (never rejects) when load() rejects', async () => {
    const { added } = installFakeFontApis()
    const { ensureViewerFontLoaded } = await importFreshFontLoading()

    const pending = ensureViewerFontLoaded()
    added[0]?.loadDeferred.reject(new Error('boom'))

    await expect(pending).resolves.toBe('degraded')
  })

  it('resolves "degraded" when FontFace is unavailable', async () => {
    uninstallFakeFontApis()
    const { ensureViewerFontLoaded } = await importFreshFontLoading()

    await expect(ensureViewerFontLoaded()).resolves.toBe('degraded')
  })

  it('resolves "degraded" when document.fonts is unavailable', async () => {
    ;(globalThis as unknown as { FontFace: unknown }).FontFace = FakeFontFace
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined })
    const { ensureViewerFontLoaded } = await importFreshFontLoading()

    await expect(ensureViewerFontLoaded()).resolves.toBe('degraded')
  })

  it('settles "degraded" at the timeout bound when load() never settles, and clears its timer', async () => {
    vi.useFakeTimers()
    installFakeFontApis()
    const { ensureViewerFontLoaded, VIEWER_FONT_LOAD_TIMEOUT_MS } = await importFreshFontLoading()

    const pending = ensureViewerFontLoaded()
    let settled: string | undefined
    void pending.then((status) => {
      settled = status
    })

    await vi.advanceTimersByTimeAsync(VIEWER_FONT_LOAD_TIMEOUT_MS - 1)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe('degraded')

    // No pending timer leaks past the settle — advancing further must not
    // throw or leave anything scheduled.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ticks the readiness subscriber once more when the face loads after a timeout-degraded settle, and never again after that', async () => {
    vi.useFakeTimers()
    const { added } = installFakeFontApis()
    const { ensureViewerFontLoaded, subscribeViewerFontReady, VIEWER_FONT_LOAD_TIMEOUT_MS } =
      await importFreshFontLoading()

    const notifications: number[] = []
    subscribeViewerFontReady(() => notifications.push(notifications.length))

    const pending = ensureViewerFontLoaded()
    await vi.advanceTimersByTimeAsync(VIEWER_FONT_LOAD_TIMEOUT_MS)
    await expect(pending).resolves.toBe('degraded')
    expect(notifications).toHaveLength(0)

    added[0]?.loadDeferred.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(notifications).toHaveLength(1)

    // No further ticks — the late-load promise itself only settles once.
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifications).toHaveLength(1)
  })

  it('clears the pending timeout when the load wins the race before the bound', async () => {
    vi.useFakeTimers()
    const { added } = installFakeFontApis()
    const { ensureViewerFontLoaded } = await importFreshFontLoading()

    const pending = ensureViewerFontLoaded()
    added[0]?.loadDeferred.resolve()
    await expect(pending).resolves.toBe('loaded')

    expect(vi.getTimerCount()).toBe(0)
  })
})
