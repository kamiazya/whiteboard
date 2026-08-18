import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDocumentRename } from './useDocumentRename'

describe('useDocumentRename', () => {
  it('startRename seeds the draft with the current name and opens the input', () => {
    const { result } = renderHook(() =>
      useDocumentRename({
        path: 'foo',
        isLocalMode: false,
        currentName: 'My Canvas',
        onRenameDocument: undefined,
        renameDocument: vi.fn().mockResolvedValue(true),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
    })
    expect(result.current.renamingDocument).toBe(true)
    expect(result.current.draft).toBe('My Canvas')
  })

  it('local mode commit calls onRenameDocument and closes the input on success', async () => {
    const onRenameDocument = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useDocumentRename({
        path: 'foo',
        isLocalMode: true,
        currentName: 'old',
        onRenameDocument,
        renameDocument: vi.fn(),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('new name')
    })
    await act(async () => {
      await result.current.commitDocumentName()
    })
    expect(onRenameDocument).toHaveBeenCalledWith('new name')
    expect(result.current.renamingDocument).toBe(false)
    expect(result.current.draft).toBe('')
    expect(result.current.renameError).toBeNull()
  })

  it('local mode commit keeps the input open and surfaces renameError on failure', async () => {
    const onRenameDocument = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() =>
      useDocumentRename({
        path: 'foo',
        isLocalMode: true,
        currentName: 'old',
        onRenameDocument,
        renameDocument: vi.fn(),
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('new name')
    })
    await act(async () => {
      await result.current.commitDocumentName()
    })
    expect(result.current.renamingDocument).toBe(true)
    expect(result.current.draft).toBe('new name')
    expect(result.current.renameError).toBe('Failed to rename canvas.')
  })

  it('daemon mode commit calls renameDocument with the path and trimmed name, then closes the input', async () => {
    const renameDocument = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() =>
      useDocumentRename({
        path: 'design/foo',
        isLocalMode: false,
        currentName: 'old',
        onRenameDocument: undefined,
        renameDocument,
        mountedRef: { current: true },
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('  new name  ')
    })
    await act(async () => {
      await result.current.commitDocumentName()
    })
    expect(renameDocument).toHaveBeenCalledWith('design/foo', 'new name')
    expect(result.current.renamingDocument).toBe(false)
    expect(result.current.draft).toBe('')
  })

  it('cancelRename resets the input and clears any renameError', () => {
    const { result } = renderHook(() =>
      useDocumentRename({
        path: 'foo',
        isLocalMode: false,
        currentName: 'old',
        onRenameDocument: undefined,
        renameDocument: vi.fn(),
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
    expect(result.current.renamingDocument).toBe(false)
    expect(result.current.draft).toBe('')
    expect(result.current.renameError).toBeNull()
  })

  it('does not update state once mountedRef flips false mid-commit', async () => {
    const mountedRef = { current: true }
    let resolveRename: (name: string) => void = () => {}
    const onRenameDocument = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRename = resolve as unknown as (name: string) => void
      }),
    )
    const { result } = renderHook(() =>
      useDocumentRename({
        path: 'foo',
        isLocalMode: true,
        currentName: 'old',
        onRenameDocument,
        renameDocument: vi.fn(),
        mountedRef,
      }),
    )
    act(() => {
      result.current.startRename()
      result.current.setDraft('new name')
    })
    const commitPromise = act(async () => {
      const p = result.current.commitDocumentName()
      // Simulate unmount happening while the rename call is still in flight.
      mountedRef.current = false
      resolveRename(undefined as unknown as string)
      await p
    })
    await commitPromise
    // The guard must keep the input open rather than reflecting the resolved commit.
    expect(result.current.renamingDocument).toBe(true)
    expect(result.current.draft).toBe('new name')
  })
})
