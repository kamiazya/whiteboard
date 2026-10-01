import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDeleteDocuments } from './use-delete-documents.js'

const lookup = (path: string) =>
  ({
    alpha: { displayName: 'Alpha board', kind: 'spatial' as const },
    beta: { displayName: 'Beta board', kind: 'spatial' as const },
  })[path]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('useDeleteDocuments', () => {
  it('starts closed, and opens on the request it is handed', () => {
    const { result } = renderHook(() =>
      useDeleteDocuments({
        keeper: 'daemon',
        deleteEach: vi.fn(async () => ({ failed: [], lastError: null })),
        lookup,
        refresh: vi.fn(),
      }),
    )
    expect(result.current.dialog.pending).toBeNull()
    expect(result.current.dialog.action).toBe('delete-document-daemon')

    act(() => {
      result.current.requestDelete({
        paths: ['alpha'],
        displayName: 'Alpha board',
        kind: 'spatial',
      })
    })
    expect(result.current.dialog.pending).toEqual({ displayName: 'Alpha board', kind: 'spatial' })
  })

  it('shows the bulk subject and the bulk sentence for more than one path', () => {
    const { result } = renderHook(() =>
      useDeleteDocuments({
        keeper: 'browser',
        deleteEach: vi.fn(async () => ({ failed: [], lastError: null })),
        lookup,
        refresh: vi.fn(),
      }),
    )
    act(() => {
      result.current.requestDelete({ paths: ['alpha', 'beta'], displayName: '2 documents' })
    })
    expect(result.current.dialog.pending).toEqual({ displayName: '2 documents', count: 2 })
    expect(result.current.dialog.action).toBe('delete-documents-browser')
  })

  it('deletes what was pending, refreshes, and closes when everything went', async () => {
    const deleteEach = vi.fn(async () => ({ failed: [], lastError: null }))
    const refresh = vi.fn()
    const { result } = renderHook(() =>
      useDeleteDocuments({ keeper: 'daemon', deleteEach, lookup, refresh }),
    )
    act(() => {
      result.current.requestDelete({ paths: ['alpha', 'beta'], displayName: '2 documents' })
    })

    await act(async () => {
      await result.current.dialog.onConfirm()
    })

    expect(deleteEach).toHaveBeenCalledWith(['alpha', 'beta'])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result.current.dialog.pending).toBeNull()
    expect(result.current.dialog.error).toBeNull()
  })

  it('reports busy while the delete is in flight, until it settles', async () => {
    // The dialog is what refuses a dismiss while busy (its own onOpenChange);
    // the hook only has to say so truthfully.
    const gate = deferred<{ failed: string[]; lastError: unknown }>()
    const { result } = renderHook(() =>
      useDeleteDocuments({
        keeper: 'daemon',
        deleteEach: () => gate.promise,
        lookup,
        refresh: vi.fn(),
      }),
    )
    act(() => {
      result.current.requestDelete({ paths: ['alpha'], displayName: 'Alpha board' })
    })
    let settled: Promise<void> | undefined
    act(() => {
      settled = result.current.dialog.onConfirm()
    })
    expect(result.current.dialog.busy).toBe(true)

    await act(async () => {
      gate.resolve({ failed: [], lastError: null })
      await settled
    })
    expect(result.current.dialog.busy).toBe(false)
    expect(result.current.dialog.pending).toBeNull()
  })

  it('re-offers exactly the paths that failed, named, with the count in the error', async () => {
    const deleteEach = vi.fn(async () => ({ failed: ['beta'], lastError: new Error('nope') }))
    const refresh = vi.fn()
    const { result } = renderHook(() =>
      useDeleteDocuments({ keeper: 'daemon', deleteEach, lookup, refresh }),
    )
    act(() => {
      result.current.requestDelete({ paths: ['alpha', 'beta'], displayName: '2 documents' })
    })
    await act(async () => {
      await result.current.dialog.onConfirm()
    })

    // The list behind the dialog has changed, so it is re-read even though
    // the dialog stays open.
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result.current.dialog.pending).toEqual({ displayName: 'Beta board', kind: 'spatial' })
    expect(result.current.dialog.action).toBe('delete-document-daemon')
    expect(result.current.dialog.error).toBe('1 of 2 could not be deleted.')

    // Pressing Delete again retries only the survivor.
    await act(async () => {
      await result.current.dialog.onConfirm()
    })
    expect(deleteEach).toHaveBeenLastCalledWith(['beta'])
  })

  it("quotes the keeper's reason when every path failed, else the fallback sentence", async () => {
    const quoted = renderHook(() =>
      useDeleteDocuments({
        keeper: 'daemon',
        deleteEach: async () => ({ failed: ['alpha'], lastError: new Error('daemon said no') }),
        lookup,
        refresh: vi.fn(),
      }),
    )
    act(() => {
      quoted.result.current.requestDelete({ paths: ['alpha'], displayName: 'Alpha board' })
    })
    await act(async () => {
      await quoted.result.current.dialog.onConfirm()
    })
    expect(quoted.result.current.dialog.error).toBe('daemon said no')

    const silent = renderHook(() =>
      useDeleteDocuments({
        keeper: 'browser',
        deleteEach: async () => ({ failed: ['alpha'], lastError: null }),
        lookup,
        refresh: vi.fn(),
      }),
    )
    act(() => {
      silent.result.current.requestDelete({ paths: ['alpha'], displayName: 'Alpha board' })
    })
    await act(async () => {
      await silent.result.current.dialog.onConfirm()
    })
    expect(silent.result.current.dialog.error).toBe(
      'Failed to delete the document from this browser.',
    )
  })

  it('keeps the dialog open with the thrown reason when the delete itself throws', async () => {
    const refresh = vi.fn()
    const { result } = renderHook(() =>
      useDeleteDocuments({
        keeper: 'daemon',
        deleteEach: async () => {
          throw new Error('network down')
        },
        lookup,
        refresh,
      }),
    )
    act(() => {
      result.current.requestDelete({ paths: ['alpha'], displayName: 'Alpha board' })
    })
    await act(async () => {
      await result.current.dialog.onConfirm()
    })
    expect(result.current.dialog.error).toBe('network down')
    expect(result.current.dialog.pending).not.toBeNull()
    expect(result.current.dialog.busy).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('drops an outcome that settles after reset, so a departed scope is never re-offered', async () => {
    // The page resets on a workspace switch while a bulk delete is in
    // flight. Without a guard the partial failure re-opened the dialog with
    // the OLD workspace's paths, and the next confirm sent them to the new
    // one — the mismatched identity the reset exists to prevent.
    const gate = deferred<{ failed: string[]; lastError: unknown }>()
    const { result } = renderHook(() =>
      useDeleteDocuments({
        keeper: 'daemon',
        deleteEach: () => gate.promise,
        lookup,
        refresh: vi.fn(),
      }),
    )
    act(() => {
      result.current.requestDelete({ paths: ['alpha', 'beta'], displayName: '2 documents' })
    })
    let settled: Promise<void> | undefined
    act(() => {
      settled = result.current.dialog.onConfirm()
    })
    act(() => {
      result.current.reset()
    })

    await act(async () => {
      gate.resolve({ failed: ['beta'], lastError: new Error('nope') })
      await settled
    })

    expect(result.current.dialog.pending).toBeNull()
    expect(result.current.dialog.error).toBeNull()
    expect(result.current.dialog.busy).toBe(false)
  })

  it('dismiss clears the request and the error, and tells the page', () => {
    const onDismiss = vi.fn()
    const { result } = renderHook(() =>
      useDeleteDocuments({
        keeper: 'daemon',
        deleteEach: vi.fn(async () => ({ failed: [], lastError: null })),
        lookup,
        refresh: vi.fn(),
        onDismiss,
      }),
    )
    act(() => {
      result.current.requestDelete({ paths: ['alpha'], displayName: 'Alpha board' })
    })
    act(() => {
      result.current.dialog.onCancel()
    })
    expect(result.current.dialog.pending).toBeNull()
    expect(onDismiss).toHaveBeenCalledTimes(1)

    // `reset` is the page's own clear (a workspace switch): no dismiss hook.
    act(() => {
      result.current.requestDelete({ paths: ['alpha'], displayName: 'Alpha board' })
      result.current.reset()
    })
    expect(result.current.dialog.pending).toBeNull()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
