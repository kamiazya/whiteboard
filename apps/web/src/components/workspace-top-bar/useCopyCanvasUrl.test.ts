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

  it('clears the pending reset timeout on unmount', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    const { result, unmount } = renderHook(() =>
      useCopyCanvasUrl('https://example.test/canvas/ws/foo'),
    )
    await act(async () => {
      await result.current.copyCanvasUrl()
    })
    expect(result.current.copyStatus).toBe('copied')
    const callsBeforeUnmount = clearTimeoutSpy.mock.calls.length
    unmount()
    // The cleanup effect must clear the pending "reset to idle" timer —
    // otherwise it fires after unmount and only the mountedRef check saves it.
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeUnmount)
  })
})
