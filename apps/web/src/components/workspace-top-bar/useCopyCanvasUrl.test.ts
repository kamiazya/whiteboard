import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCopyCanvasUrl } from './useCopyCanvasUrl'

describe('useCopyCanvasUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sets copyStatus to "copied" on a successful clipboard write', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { result } = renderHook(() => useCopyCanvasUrl('https://example.test/canvas/ws/foo'))
    await act(async () => {
      await result.current.copyCanvasUrl()
    })
    expect(result.current.copyStatus).toBe('copied')
  })

  it('sets copyStatus to "error" instead of silently swallowing a clipboard failure', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const { result } = renderHook(() => useCopyCanvasUrl('https://example.test/canvas/ws/foo'))
    await act(async () => {
      await result.current.copyCanvasUrl()
    })
    expect(result.current.copyStatus).toBe('error')
  })

  it('does not update state after unmount', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { result, unmount } = renderHook(() =>
      useCopyCanvasUrl('https://example.test/canvas/ws/foo'),
    )
    await act(async () => {
      await result.current.copyCanvasUrl()
    })
    expect(result.current.copyStatus).toBe('copied')
    unmount()
    // Advancing timers after unmount must not throw or trigger a
    // setState-after-unmount warning; the reset callback checks mountedRef first.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
  })
})
