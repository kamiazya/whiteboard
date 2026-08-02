import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeFontApis, uninstallFakeFontApis } from './test-utils/fake-font-face.js'

describe('useViewerFontReady', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    uninstallFakeFontApis()
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

    // The font settles AFTER the component has already unmounted.
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
