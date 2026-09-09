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

  it('does not tick the readiness subscriber when the late load fails after a timeout-degraded settle', async () => {
    vi.useFakeTimers()
    const { added } = installFakeFontApis()
    const { ensureViewerFontLoaded, subscribeViewerFontReady, VIEWER_FONT_LOAD_TIMEOUT_MS } =
      await importFreshFontLoading()

    let notifications = 0
    subscribeViewerFontReady(() => {
      notifications += 1
    })

    const pending = ensureViewerFontLoaded()
    await vi.advanceTimersByTimeAsync(VIEWER_FONT_LOAD_TIMEOUT_MS)
    await expect(pending).resolves.toBe('degraded')

    added[0]?.loadDeferred.reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(1000)

    // A tick means "the real face is available now". The load failed, so
    // the face is still absent — ticking would tell subscribers to
    // re-measure against metrics that did not change.
    expect(notifications).toBe(0)
  })

  it('reports "loaded" to a caller arriving after a late successful load, not the stale timeout verdict', async () => {
    vi.useFakeTimers()
    const { added } = installFakeFontApis()
    const { ensureViewerFontLoaded, VIEWER_FONT_LOAD_TIMEOUT_MS } = await importFreshFontLoading()

    const pending = ensureViewerFontLoaded()
    await vi.advanceTimersByTimeAsync(VIEWER_FONT_LOAD_TIMEOUT_MS)
    await expect(pending).resolves.toBe('degraded')

    added[0]?.loadDeferred.resolve()
    await vi.advanceTimersByTimeAsync(0)

    // The face is present now. A consumer mounting at this point missed the
    // readiness tick, so the status is the only thing that can tell it.
    await expect(ensureViewerFontLoaded()).resolves.toBe('loaded')
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

describe('hasLoadedFace', () => {
  afterEach(() => {
    uninstallFakeFontApis()
    delete (document as unknown as { fonts?: unknown }).fonts
  })

  function installFaceSet(faces: readonly { family: string; status: string }[]) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { [Symbol.iterator]: () => faces[Symbol.iterator]() },
    })
  }

  it('the vendored family is always available: it is what layout measures with', async () => {
    const { hasLoadedFace } = await importFreshFontLoading()
    const { VIEWER_FONT_FAMILY } = await import('./font.js')
    expect(hasLoadedFace(VIEWER_FONT_FAMILY)).toBe(true)
  })

  it('a family is available only while this realm holds a LOADED face for it', async () => {
    const { hasLoadedFace } = await importFreshFontLoading()
    installFaceSet([
      { family: '"Patrick Hand"', status: 'loaded' },
      { family: 'Caveat', status: 'loading' },
    ])
    expect(hasLoadedFace('Patrick Hand')).toBe(true)
    expect(hasLoadedFace('Caveat')).toBe(false)
    expect(hasLoadedFace('Nobody')).toBe(false)
  })

  it('answers false, never throws, in a realm with no face set', async () => {
    const { hasLoadedFace } = await importFreshFontLoading()
    expect(hasLoadedFace('Patrick Hand')).toBe(false)
  })
})

describe('registerFontBytes', () => {
  afterEach(() => {
    uninstallFakeFontApis()
    delete (document as unknown as { fonts?: unknown }).fonts
  })

  it('registers a face from bytes in this realm, so hasLoadedFace answers true', async () => {
    const { added } = installFakeFontApis()
    const { registerFontBytes, hasLoadedFace } = await importFreshFontLoading()
    const pending = registerFontBytes('Yomogi', new Uint8Array([1, 2, 3]).buffer)
    expect(added).toHaveLength(1)
    expect(added[0]?.family).toBe('Yomogi')
    added[0]?.loadDeferred.resolve()
    await expect(pending).resolves.toBe('loaded')
    expect(hasLoadedFace('Yomogi')).toBe(true)
  })

  it('a second registration of the same family is a no-op that answers the first', async () => {
    const { added } = installFakeFontApis()
    const { registerFontBytes } = await importFreshFontLoading()
    const first = registerFontBytes('Yomogi', new Uint8Array([1]).buffer)
    const second = registerFontBytes('Yomogi', new Uint8Array([2]).buffer)
    expect(added).toHaveLength(1)
    added[0]?.loadDeferred.resolve()
    await expect(first).resolves.toBe('loaded')
    await expect(second).resolves.toBe('loaded')
  })

  it('answers degraded, never throws, where FontFace is unavailable', async () => {
    uninstallFakeFontApis()
    const { registerFontBytes } = await importFreshFontLoading()
    await expect(registerFontBytes('Yomogi', new Uint8Array([1]).buffer)).resolves.toBe('degraded')
  })
})
