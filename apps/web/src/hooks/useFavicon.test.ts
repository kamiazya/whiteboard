import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as favicon from '../lib/favicon.js'
import { useFavicon } from './useFavicon.js'

// The dynamic favicon exists only while a canvas page is mounted. Every
// other surface (gallery, /pair, error pages) must see the static icon —
// which is exactly the unmount cleanup's job, pinned here.
describe('useFavicon lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const l of document.head.querySelectorAll('link[rel="icon"]')) l.remove()
  })

  it('restores the static favicon on unmount (navigation away from the canvas)', () => {
    const { unmount } = renderHook(() => useFavicon({ style: 'dot', status: 'saved', rects: [] }))
    vi.advanceTimersByTime(500)
    unmount()
    const links = document.head.querySelectorAll('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe(favicon.STATIC_FAVICON_HREF)
  })

  it('does not install a broken icon where canvas 2D is unavailable (jsdom)', () => {
    renderHook(() => useFavicon({ style: 'minimap', status: 'saved', rects: [] }))
    vi.advanceTimersByTime(500)
    // renderFavicon returns null here, so the hook must leave the head alone.
    expect(document.head.querySelector('link[data-wb-favicon]')).toBeNull()
  })

  it('cancels the pending debounce on unmount: renderFavicon never fires post-unmount', () => {
    const renderFaviconSpy = vi.spyOn(favicon, 'renderFavicon')
    const { unmount } = renderHook(() => useFavicon({ style: 'dot', status: 'saved', rects: [] }))
    unmount()
    vi.runAllTimers()
    expect(renderFaviconSpy).not.toHaveBeenCalled()
  })
})
