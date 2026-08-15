import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useGestureCaptured } from './use-gesture-captured.js'

describe('useGestureCaptured', () => {
  it('freezes the value for the lifetime of one gesture', () => {
    // The committed anchors arrive asynchronously from the layout worker; a
    // reply landing MID-GESTURE must not swap the points bystander edges are
    // pinned to — that is the exact re-fraction the capture exists to stop.
    const a = new Map([['e1', 1]])
    const b = new Map([['e1', 2]])
    const { result, rerender } = renderHook(
      ({ active, value }: { active: boolean; value: Map<string, number> }) =>
        useGestureCaptured(active, value),
      { initialProps: { active: false, value: a } },
    )
    expect(result.current).toBe(a)

    act(() => rerender({ active: true, value: a }))
    expect(result.current).toBe(a)

    // The worker reply lands while the gesture is still in flight.
    act(() => rerender({ active: true, value: b }))
    expect(result.current).toBe(a)
  })

  it('releases the capture when the gesture ends, so the next gesture sees fresh state', () => {
    const a = new Map([['e1', 1]])
    const b = new Map([['e1', 2]])
    const { result, rerender } = renderHook(
      ({ active, value }: { active: boolean; value: Map<string, number> }) =>
        useGestureCaptured(active, value),
      { initialProps: { active: true, value: a } },
    )
    expect(result.current).toBe(a)

    act(() => rerender({ active: false, value: b }))
    act(() => rerender({ active: true, value: b }))
    expect(result.current).toBe(b)
  })
})
