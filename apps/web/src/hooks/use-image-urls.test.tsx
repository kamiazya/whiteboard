/**
 * The shared object-URL cache. Two of these cases pin failure modes a
 * straightforward cache has: a rejecting loader takes the whole batch down,
 * and a URL minted after cleanup is dropped where nothing could ever revoke it.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useImageUrls } from './use-image-urls.js'
import { TRANSIENT_LOAD_ATTEMPTS } from './use-prefetched-cache.js'

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

  it('asks again for a load that rejected, with the same refs, and installs the answer', async () => {
    // A rejection is a failed read — a busy daemon, a dropped request — and
    // the refs of an open board do not change on their own, so waiting for
    // them to left the picture on its card for the life of the page.
    let failures = 1
    const load = vi.fn(async (ref: string) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('busy')
      }
      return `blob:${ref}`
    })
    const { result } = renderHook(() => useImageUrls(['asset:a'], load))
    await waitFor(() => expect(result.current.get('asset:a')).toBe('blob:asset:a'))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('stops asking after a bounded number of rejections, and never re-asks an absent picture', async () => {
    const load = vi.fn(async (ref: string) => {
      if (ref === 'asset:broken') throw new Error('busy')
      return undefined
    })
    const { result, rerender } = renderHook(() =>
      useImageUrls(['asset:broken', 'asset:gone'], load),
    )
    await waitFor(() =>
      expect(load.mock.calls.filter(([ref]) => ref === 'asset:broken')).toHaveLength(
        TRANSIENT_LOAD_ATTEMPTS,
      ),
    )
    // Settle anything a further round would have started, then look again.
    for (let i = 0; i < 5; i += 1) {
      rerender()
      await act(async () => {})
    }
    expect(load.mock.calls.filter(([ref]) => ref === 'asset:broken')).toHaveLength(
      TRANSIENT_LOAD_ATTEMPTS,
    )
    expect(load.mock.calls.filter(([ref]) => ref === 'asset:gone')).toHaveLength(1)
    expect(result.current.size).toBe(0)
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
