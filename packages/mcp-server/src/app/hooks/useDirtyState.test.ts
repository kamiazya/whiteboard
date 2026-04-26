// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDirtyState } from './useDirtyState.js'

// Thin CustomEvent helpers; jsdom can dispatch these directly.
function dispatchDocChanged(workspaceId: string, slug: string): void {
  window.dispatchEvent(
    new CustomEvent('excalidraw:doc_changed', { detail: { workspaceId, slug } }),
  )
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
})
