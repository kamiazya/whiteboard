import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedValue } from './use-debounced-value.js'

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles on the latest value after the trailing edge, never on an intermediate one', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 150), {
      initialProps: { value: 'a' },
    })
    expect(result.current).toBe('a')

    rerender({ value: 'b' })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    rerender({ value: 'c' })
    act(() => {
      vi.advanceTimersByTime(149)
    })
    // Trailing timer restarted on each change; 149ms since 'c' is not enough.
    expect(result.current).toBe('a')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe('c')
  })

  it('does not update state after unmount when the pending timer would have fired', () => {
    const { result, rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value, 150), {
      initialProps: { value: 'a' },
    })
    rerender({ value: 'b' })
    unmount()
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(200)
      })
    }).not.toThrow()
    expect(result.current).toBe('a')
  })
})
