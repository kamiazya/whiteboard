import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as favicon from '../lib/favicon.js'
import { useFavicon } from './useFavicon.js'

// The dynamic favicon exists only while a canvas page is mounted. Every
// other surface (gallery, /pair, error pages) must see the static icon —
// which is exactly the unmount cleanup's job, pinned here.
describe('useFavicon lifecycle', () => {
  // Links are cleared on BOTH sides of a test. Testing Library's auto-cleanup
  // is registered in the setup file, so under vitest's stack ordering it runs
  // after this file's afterEach — and unmounting a hook this file left mounted
  // installs the static icon (that is the unmount's job). Clearing only in
  // afterEach therefore let that link leak into the next test, which under an
  // in-process repeat is this same file's "installs nothing" case.
  const clearIconLinks = () => {
    for (const l of document.head.querySelectorAll('link[rel="icon"]')) l.remove()
  }
  beforeEach(() => {
    vi.useFakeTimers()
    clearIconLinks()
  })
  afterEach(() => {
    vi.useRealTimers()
    clearIconLinks()
  })

  it('restores the static favicon on unmount (navigation away from the canvas)', () => {
    const { unmount } = renderHook(() => useFavicon({ style: 'dot', status: 'quiet', rects: [] }))
    vi.advanceTimersByTime(500)
    unmount()
    const links = document.head.querySelectorAll('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe(favicon.STATIC_FAVICON_HREF)
  })

  it('does not install a broken icon where canvas 2D is unavailable (jsdom)', () => {
    const { unmount } = renderHook(() =>
      useFavicon({ style: 'minimap', status: 'quiet', rects: [] }),
    )
    vi.advanceTimersByTime(500)
    // renderFavicon returns null here, so the hook must leave the head alone.
    expect(document.head.querySelector('link[data-wb-favicon]')).toBeNull()
    // Unmounted here rather than by auto-cleanup, so the static icon the
    // unmount installs is this test's to clear and cannot outlive it.
    unmount()
  })

  it('cancels the pending debounce on unmount: renderFavicon never fires post-unmount', () => {
    const renderFaviconSpy = vi.spyOn(favicon, 'renderFavicon')
    const { unmount } = renderHook(() => useFavicon({ style: 'dot', status: 'quiet', rects: [] }))
    unmount()
    vi.runAllTimers()
    expect(renderFaviconSpy).not.toHaveBeenCalled()
  })
})
