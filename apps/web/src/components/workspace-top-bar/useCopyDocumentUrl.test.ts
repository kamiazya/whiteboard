import { act, renderHook } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCopyDocumentUrl } from './useCopyDocumentUrl'

// Every call site owns a mountedRef the way WorkspaceTopBar does (created
// fresh per test, defaulted to "mounted").
function useMountedCopyDocumentUrl(documentUrl: string) {
  const mountedRef = useRef(true)
  return useCopyDocumentUrl(documentUrl, undefined, mountedRef)
}

describe('useCopyDocumentUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sets copyStatus to "copied" on a successful clipboard write', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { result } = renderHook(() =>
      useMountedCopyDocumentUrl('https://example.test/document/ws/foo'),
    )
    await act(async () => {
      await result.current.copyDocumentUrl()
    })
    expect(result.current.copyStatus).toBe('copied')
  })

  it('sets copyStatus to "error" instead of silently swallowing a clipboard failure', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const { result } = renderHook(() =>
      useMountedCopyDocumentUrl('https://example.test/document/ws/foo'),
    )
    await act(async () => {
      await result.current.copyDocumentUrl()
    })
    expect(result.current.copyStatus).toBe('error')
  })

  it('clears the pending reset timeout on unmount', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    const { result, unmount } = renderHook(() =>
      useMountedCopyDocumentUrl('https://example.test/document/ws/foo'),
    )
    await act(async () => {
      await result.current.copyDocumentUrl()
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
    // WorkspaceTopBar's shared mountedRef, passed to useDocumentRename and
    // useCreateDocument) must make this hook survive StrictMode's dev-only
    // setup->cleanup->setup cycle instead of getting stuck "unmounted".
    const { result } = renderHook(
      () => {
        const mountedRef = useRef(true)
        const hook = useCopyDocumentUrl(
          'https://example.test/document/ws/foo',
          undefined,
          mountedRef,
        )
        return { mountedRef, hook }
      },
      { wrapper: StrictMode },
    )

    await act(async () => {
      await result.current.hook.copyDocumentUrl()
    })

    expect(result.current.hook.copyStatus).toBe('copied')
  })
})
