import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDropSettle } from './use-drop-settle.js'

describe('useDropSettle', () => {
  const run = (initial: { inFlight: boolean; live: string; sceneCurrent: boolean }) =>
    renderHook(
      ({ inFlight, live, sceneCurrent }: typeof initial) =>
        useDropSettle(inFlight, live, sceneCurrent),
      { initialProps: initial },
    )

  it('holds the last in-flight frame while the committed scene is behind', () => {
    // The layout worker owes the drop a scene; until it lands, the committed
    // surface still draws the node at the grab point.
    const { result, rerender } = run({ inFlight: true, live: 'dragging', sceneCurrent: true })
    act(() => rerender({ inFlight: true, live: 'at drop', sceneCurrent: true }))
    act(() => rerender({ inFlight: false, live: 'committed', sceneCurrent: false }))
    expect(result.current).toEqual({ frame: 'at drop', settling: true })
  })

  it('reports no settle while the gesture is still in flight', () => {
    // The caller answers the geometry question from the commit only once
    // nobody is pointing at the frame any more.
    const { result } = run({ inFlight: true, live: 'dragging', sceneCurrent: false })
    expect(result.current).toEqual({ frame: 'dragging', settling: false })
  })

  it('releases the frame as soon as the scene carries the drop', () => {
    const { result, rerender } = run({ inFlight: true, live: 'at drop', sceneCurrent: true })
    act(() => rerender({ inFlight: false, live: 'committed', sceneCurrent: false }))
    act(() => rerender({ inFlight: false, live: 'committed', sceneCurrent: true }))
    expect(result.current).toEqual({ frame: 'committed', settling: false })
  })

  it('holds nothing when the drop changed nothing, so the scene never went stale', () => {
    const { result, rerender } = run({ inFlight: true, live: 'at drop', sceneCurrent: true })
    act(() => rerender({ inFlight: false, live: 'committed', sceneCurrent: true }))
    expect(result.current).toEqual({ frame: 'committed', settling: false })
  })

  it('a new gesture takes over from a hold that has not been released yet', () => {
    // A stale scene must never hand the next drag the previous drop's frame.
    const { result, rerender } = run({ inFlight: true, live: 'first drop', sceneCurrent: true })
    act(() => rerender({ inFlight: false, live: 'committed', sceneCurrent: false }))
    act(() => rerender({ inFlight: true, live: 'second drag', sceneCurrent: false }))
    expect(result.current).toEqual({ frame: 'second drag', settling: false })
    act(() => rerender({ inFlight: false, live: 'committed', sceneCurrent: false }))
    expect(result.current).toEqual({ frame: 'second drag', settling: true })
  })
})
