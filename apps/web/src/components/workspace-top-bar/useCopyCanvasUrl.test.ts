import { act, renderHook } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCopyCanvasUrl } from './useCopyCanvasUrl'

// Every call site owns a mountedRef the way WorkspaceTopBar does (created
// fresh per test, defaulted to "mounted").
function useMountedCopyCanvasUrl(canvasUrl: string) {
  const mountedRef = useRef(true)
  return useCopyCanvasUrl(canvasUrl, undefined, mountedRef)
}

describe('useCopyCanvasUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sets copyStatus to "copied" on a successful clipboard write', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { result } = renderHook(() =>
      useMountedCopyCanvasUrl('https://example.test/canvas/ws/foo'),
    )
    await act(async () => {
      await result.current.copyCanvasUrl()
    })
    expect(result.current.copyStatus).toBe('copied')
  })

  it('sets copyStatus to "error" instead of silently swallowing a clipboard failure', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const { result } = renderHook(() =>
      useMountedCopyCanvasUrl('https://example.test/canvas/ws/foo'),
    )
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
      useMountedCopyCanvasUrl('https://example.test/canvas/ws/foo'),
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

  it('keeps reporting copyStatus after React StrictMode dev double-invoke', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    // A mountedRef owned and re-armed by the parent (mirrors
    // WorkspaceTopBar's shared mountedRef, passed to useCanvasRename and
    // useCreateCanvas) must make this hook survive StrictMode's dev-only
    // setup->cleanup->setup cycle instead of getting stuck "unmounted".
    const { result } = renderHook(
      () => {
        const mountedRef = useRef(true)
        const hook = useCopyCanvasUrl('https://example.test/canvas/ws/foo', undefined, mountedRef)
        return { mountedRef, hook }
      },
      { wrapper: StrictMode },
    )

    await act(async () => {
      await result.current.hook.copyCanvasUrl()
    })

    expect(result.current.hook.copyStatus).toBe('copied')
  })
})
