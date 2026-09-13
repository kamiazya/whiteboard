/**
 * The shared object-URL cache. Two of these cases are CodeRabbit findings on
 * the PR that extracted it, each verified against the code before being
 * acted on — a rejecting loader took the whole batch down, and a URL minted
 * after cleanup was dropped where nothing could ever revoke it.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useImageUrls } from './use-image-urls.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useImageUrls', () => {
  it('installs the loads that succeeded even when one rejects', async () => {
    // `Promise.all` rejects on the first rejection, so the callback installed
    // NONE of the successful URLs and the rejection went unhandled. A loader
    // is a backend binding this hook does not own; it may throw.
    const load = vi.fn(async (ref: string) => {
      if (ref === 'asset:bad') throw new Error('gone')
      return `blob:${ref}`
    })
    const { result } = renderHook(() => useImageUrls(['asset:a', 'asset:bad', 'asset:b'], load))
    await waitFor(() => expect(result.current.size).toBe(2))
    expect(result.current.get('asset:a')).toBe('blob:asset:a')
    expect(result.current.get('asset:b')).toBe('blob:asset:b')
    expect(result.current.has('asset:bad')).toBe(false)
  })

  it('revokes a URL that arrives after the load was cancelled', async () => {
    // Minted by the loader, discarded by the cancelled callback, and absent
    // from the map the unmount cleanup revokes — so it leaks for the tab's
    // lifetime with nothing holding a reference to it.
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = vi.fn(async (ref: string) => {
      await gate
      return `blob:${ref}`
    })
    const { unmount } = renderHook(() => useImageUrls(['asset:slow'], load))
    await waitFor(() => expect(load).toHaveBeenCalled())
    unmount()
    release?.()
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:asset:slow'))
  })

  it('revokes what it installed, on unmount', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { result, unmount } = renderHook(() =>
      useImageUrls(['asset:a'], async (ref) => `blob:${ref}`),
    )
    await waitFor(() => expect(result.current.size).toBe(1))
    unmount()
    expect(revoke).toHaveBeenCalledWith('blob:asset:a')
  })

  it('asks for nothing without a loader', () => {
    const { result } = renderHook(() => useImageUrls(['asset:a'], undefined))
    expect(result.current.size).toBe(0)
  })
})
