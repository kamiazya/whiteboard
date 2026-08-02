import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom has no real FontFace/document.fonts (see font-loading.test.tsx's own
// note); ensureViewerFontLoaded() memoizes its promise at module scope, so
// every case imports a fresh module instance via vi.resetModules().
class FakeFontFace {
  loadDeferred: { resolve: () => void }
  private loadPromise: Promise<FakeFontFace>

  constructor(
    public family: string,
    public source: string,
  ) {
    let resolve!: () => void
    this.loadPromise = new Promise<FakeFontFace>((res) => {
      resolve = () => res(this)
    })
    this.loadDeferred = { resolve }
  }

  load(): Promise<FakeFontFace> {
    return this.loadPromise
  }
}

function installFakeFontApis(): { added: FakeFontFace[] } {
  const added: FakeFontFace[] = []
  ;(globalThis as any).FontFace = FakeFontFace
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add(face: FakeFontFace) {
        added.push(face)
      },
    },
  })
  return { added }
}

describe('useViewerFontReady', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    delete (globalThis as any).FontFace
  })

  it('performs no state update and emits no React warning when the font resolves after unmount', async () => {
    vi.resetModules()
    const { added } = installFakeFontApis()
    const { useViewerFontReady } = await import('./use-viewer-font-ready.js')

    function Probe() {
      useViewerFontReady()
      return null
    }

    const { unmount } = render(<Probe />)
    unmount()

    // The font settles AFTER the component has already unmounted — this is
    // the ordering MUST-FIX #1 exists to cover.
    added[0]?.loadDeferred.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('flips true once the font is ready while still mounted', async () => {
    vi.resetModules()
    const { added } = installFakeFontApis()
    const { useViewerFontReady } = await import('./use-viewer-font-ready.js')

    const renders: boolean[] = []
    function Probe() {
      const ready = useViewerFontReady()
      renders.push(ready)
      return null
    }

    render(<Probe />)
    expect(renders.at(-1)).toBe(false)

    await act(async () => {
      added[0]?.loadDeferred.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(renders.at(-1)).toBe(true)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })
})
