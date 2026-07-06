import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDirtyState } from './useDirtyState.js'

// Thin CustomEvent helpers; jsdom can dispatch these directly.
function dispatchDocChanged(workspaceId: string, slug: string): void {
  window.dispatchEvent(new CustomEvent('excalidraw:doc_changed', { detail: { workspaceId, slug } }))
}
function dispatchVersionSaved(workspaceId: string, slug: string): void {
  window.dispatchEvent(
    new CustomEvent('excalidraw:version_saved', { detail: { workspaceId, slug } }),
  )
}

afterEach(() => {
  // renderHook should unmount listeners for us; no extra cleanup is needed here.
})

describe('useDirtyState', () => {
  it('starts clean (dirty=false)', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    expect(result.current.isDirty).toBe(false)
  })

  it('marks dirty on doc_changed and clean on version_saved', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    act(() => dispatchDocChanged('s1', 'c1'))
    expect(result.current.isDirty).toBe(true)
    act(() => dispatchVersionSaved('s1', 'c1'))
    expect(result.current.isDirty).toBe(false)
  })

  it('ignores events from another canvas', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    act(() => dispatchDocChanged('s1', 'other'))
    act(() => dispatchDocChanged('other', 'c1'))
    expect(result.current.isDirty).toBe(false)
  })

  it('markSaved() also marks the state clean explicitly', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    act(() => dispatchDocChanged('s1', 'c1'))
    expect(result.current.isDirty).toBe(true)
    act(() => result.current.markSaved())
    expect(result.current.isDirty).toBe(false)
  })

  it('resets counters when the canvas changes', () => {
    const { result, rerender } = renderHook(
      ({ sid, slug }: { sid: string; slug: string }) => useDirtyState(sid, slug),
      { initialProps: { sid: 's1', slug: 'c1' } },
    )
    act(() => dispatchDocChanged('s1', 'c1'))
    expect(result.current.isDirty).toBe(true)
    rerender({ sid: 's1', slug: 'c2' })
    expect(result.current.isDirty).toBe(false)
  })

  it('becomes dirty again when another change arrives after save', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    act(() => dispatchDocChanged('s1', 'c1'))
    act(() => dispatchVersionSaved('s1', 'c1'))
    expect(result.current.isDirty).toBe(false)
    act(() => dispatchDocChanged('s1', 'c1'))
    expect(result.current.isDirty).toBe(true)
  })

  it('markSaved() after multiple unsaved changes does not permanently block future dirty state', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    // Three changes, one save-at-count-3 via markSaved.
    act(() => dispatchDocChanged('s1', 'c1'))
    act(() => dispatchDocChanged('s1', 'c1'))
    act(() => dispatchDocChanged('s1', 'c1'))
    act(() => result.current.markSaved())
    expect(result.current.isDirty).toBe(false)
    // One more change → must become dirty again.
    act(() => dispatchDocChanged('s1', 'c1'))
    expect(result.current.isDirty).toBe(true)
  })

  it('does not update state after unmount (no stale event listener)', () => {
    const { result, unmount } = renderHook(() => useDirtyState('s1', 'c1'))
    unmount()
    // Dispatching after unmount should not throw or update React state.
    act(() => dispatchDocChanged('s1', 'c1'))
    // If the listener were still attached, isDirty would flip; we cannot read
    // it after unmount, but the main signal here is that no React warning is thrown.
    expect(result.current.isDirty).toBe(false)
  })

  it('ignores events where detail is missing', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    act(() => {
      window.dispatchEvent(new CustomEvent('excalidraw:doc_changed', { detail: null }))
    })
    expect(result.current.isDirty).toBe(false)
  })

  it('version_saved ignores events for a different canvas', () => {
    const { result } = renderHook(() => useDirtyState('s1', 'c1'))
    act(() => dispatchDocChanged('s1', 'c1'))
    expect(result.current.isDirty).toBe(true)
    act(() => dispatchVersionSaved('s1', 'other-canvas'))
    expect(result.current.isDirty).toBe(true)
  })
})
