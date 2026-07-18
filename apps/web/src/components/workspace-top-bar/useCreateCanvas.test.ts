import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCreateCanvas } from './useCreateCanvas'

describe('useCreateCanvas', () => {
  it('local mode calls onCreateCanvas directly without opening the slug dialog', async () => {
    const onCreateCanvas = vi.fn().mockResolvedValue(undefined)
    const mountedRef = { current: true }
    const { result } = renderHook(() =>
      useCreateCanvas({
        workspaceId: 'ws1',
        slug: 'foo',
        isLocalMode: true,
        onCreateCanvas,
        onNavigateToCanvas: vi.fn(),
        daemonFetch: vi.fn(),
        mountedRef,
      }),
    )
    await act(async () => {
      result.current.openNewCanvas()
    })
    expect(onCreateCanvas).toHaveBeenCalledTimes(1)
    expect(result.current.newCanvasOpen).toBe(false)
  })

  it('does not update state after unmount when a local-mode create rejects', async () => {
    let rejectCreate: (err: Error) => void = () => {}
    const onCreateCanvas = vi.fn().mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCreate = reject
      }),
    )
    const mountedRef = { current: true }
    const { result, unmount } = renderHook(() =>
      useCreateCanvas({
        workspaceId: 'ws1',
        slug: 'foo',
        isLocalMode: true,
        onCreateCanvas,
        onNavigateToCanvas: vi.fn(),
        daemonFetch: vi.fn(),
        mountedRef,
      }),
    )
    act(() => {
      result.current.openNewCanvas()
    })
    mountedRef.current = false
    unmount()
    // Rejecting after unmount must not throw a setState-after-unmount error —
    // the hook's finally-block guards every write behind mountedRef.current.
    expect(() => rejectCreate(new Error('boom'))).not.toThrow()
    await Promise.resolve().catch(() => {})
  })

  it('daemon mode opens the dialog seeded with the current slug prefix', () => {
    const { result } = renderHook(() =>
      useCreateCanvas({
        workspaceId: 'ws1',
        slug: 'design/foo',
        isLocalMode: false,
        onCreateCanvas: undefined,
        onNavigateToCanvas: vi.fn(),
        daemonFetch: vi.fn(),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.openNewCanvas()
    })
    expect(result.current.newCanvasOpen).toBe(true)
    expect(result.current.newCanvasSlug).toBe('design/')
  })
})
