import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCanvasRename } from './useCanvasRename'

describe('useCanvasRename', () => {
  it('startRename seeds the draft with the current name and opens the input', () => {
    const { result } = renderHook(() =>
      useCanvasRename({
        slug: 'foo',
        isLocalMode: false,
        currentName: 'My Canvas',
        onRenameCanvas: undefined,
        renameCanvas: vi.fn().mockResolvedValue(true),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
    })
    expect(result.current.renamingCanvas).toBe(true)
    expect(result.current.draft).toBe('My Canvas')
  })

  it('local mode commit calls onRenameCanvas and closes the input on success', async () => {
    const onRenameCanvas = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useCanvasRename({
        slug: 'foo',
        isLocalMode: true,
        currentName: 'old',
        onRenameCanvas,
        renameCanvas: vi.fn(),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('new name')
    })
    await act(async () => {
      await result.current.commitCanvasName()
    })
    expect(onRenameCanvas).toHaveBeenCalledWith('new name')
    expect(result.current.renamingCanvas).toBe(false)
    expect(result.current.draft).toBe('')
    expect(result.current.renameError).toBeNull()
  })

  it('local mode commit keeps the input open and surfaces renameError on failure', async () => {
    const onRenameCanvas = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() =>
      useCanvasRename({
        slug: 'foo',
        isLocalMode: true,
        currentName: 'old',
        onRenameCanvas,
        renameCanvas: vi.fn(),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('new name')
    })
    await act(async () => {
      await result.current.commitCanvasName()
    })
    expect(result.current.renamingCanvas).toBe(true)
    expect(result.current.draft).toBe('new name')
    expect(result.current.renameError).toBe('Failed to rename canvas.')
  })

  it('daemon mode commit calls renameCanvas with the slug and trimmed name, then closes the input', async () => {
    const renameCanvas = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() =>
      useCanvasRename({
        slug: 'design/foo',
        isLocalMode: false,
        currentName: 'old',
        onRenameCanvas: undefined,
        renameCanvas,
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('  new name  ')
    })
    await act(async () => {
      await result.current.commitCanvasName()
    })
    expect(renameCanvas).toHaveBeenCalledWith('design/foo', 'new name')
    expect(result.current.renamingCanvas).toBe(false)
    expect(result.current.draft).toBe('')
  })

  it('cancelRename resets the input and clears any renameError', () => {
    const { result } = renderHook(() =>
      useCanvasRename({
        slug: 'foo',
        isLocalMode: false,
        currentName: 'old',
        onRenameCanvas: undefined,
        renameCanvas: vi.fn(),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('draft text')
    })
    act(() => {
      result.current.cancelRename()
    })
    expect(result.current.renamingCanvas).toBe(false)
    expect(result.current.draft).toBe('')
    expect(result.current.renameError).toBeNull()
  })

  it('does not update state once mountedRef flips false mid-commit', async () => {
    const mountedRef = { current: true }
    let resolveRename: (name: string) => void = () => {}
    const onRenameCanvas = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRename = resolve as unknown as (name: string) => void
      }),
    )
    const { result } = renderHook(() =>
      useCanvasRename({
        slug: 'foo',
        isLocalMode: true,
        currentName: 'old',
        onRenameCanvas,
        renameCanvas: vi.fn(),
        mountedRef,
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('new name')
    })
    const commitPromise = act(async () => {
      const p = result.current.commitCanvasName()
      // Simulate unmount happening while the rename call is still in flight.
      mountedRef.current = false
      resolveRename(undefined as unknown as string)
      await p
    })
    await commitPromise
    // The guard must keep the input open rather than reflecting the resolved commit.
    expect(result.current.renamingCanvas).toBe(true)
    expect(result.current.draft).toBe('new name')
  })
})
