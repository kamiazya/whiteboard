import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_HIGHLIGHT_MS, AGENT_PRESENCE_MS, useAgentActivity } from './use-agent-activity.js'

const REPORT = {
  touched: { nodes: ['a', 'b'], edges: ['e'] },
  summary: 'added 2',
}

describe('useAgentActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle', () => {
    const { result } = renderHook(() => useAgentActivity())

    expect(result.current.state.active).toBe(false)
    expect(result.current.state.summary).toBe(null)
    expect(result.current.state.touchedNodeIds.size).toBe(0)
  })

  it('goes active and marks what the agent touched', () => {
    const { result } = renderHook(() => useAgentActivity())

    act(() => result.current.report(REPORT))

    expect(result.current.state.active).toBe(true)
    expect(result.current.state.summary).toBe('added 2')
    expect([...result.current.state.touchedNodeIds]).toEqual(['a', 'b'])
    expect([...result.current.state.touchedEdgeIds]).toEqual(['e'])
  })

  it('drops the highlight first and keeps the chip labelled', () => {
    // The two timers are deliberately different lengths. Clearing `summary`
    // along with the highlight would blank the label of a chip still on
    // screen, which reads as a bug rather than as a fading highlight.
    const { result } = renderHook(() => useAgentActivity())

    act(() => result.current.report(REPORT))
    act(() => {
      vi.advanceTimersByTime(AGENT_HIGHLIGHT_MS)
    })

    expect(result.current.state.touchedNodeIds.size).toBe(0)
    expect(result.current.state.active).toBe(true)
    expect(result.current.state.summary).toBe('added 2')
  })

  it('lapses back to idle once the agent stops', () => {
    // Lapsing is what makes a crashed agent disappear on its own. The server
    // sends no "done", so nothing else would ever clear this.
    const { result } = renderHook(() => useAgentActivity())

    act(() => result.current.report(REPORT))
    act(() => {
      vi.advanceTimersByTime(AGENT_PRESENCE_MS)
    })

    expect(result.current.state.active).toBe(false)
    expect(result.current.state.summary).toBe(null)
  })

  it('restarts both timers on a burst rather than accumulating', () => {
    // A run of batches should read as one continuous session, not flicker.
    const { result } = renderHook(() => useAgentActivity())

    act(() => result.current.report(REPORT))
    act(() => {
      vi.advanceTimersByTime(AGENT_PRESENCE_MS - 1_000)
    })
    act(() => result.current.report({ touched: { nodes: ['c'], edges: [] }, summary: 'added 1' }))

    // Past the ORIGINAL presence deadline, still active because the second
    // report reset it.
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(result.current.state.active).toBe(true)
    expect(result.current.state.summary).toBe('added 1')
  })

  it('shows only the most recent change, not a union of every one', () => {
    const { result } = renderHook(() => useAgentActivity())

    act(() => result.current.report(REPORT))
    act(() => result.current.report({ touched: { nodes: ['c'], edges: [] }, summary: 'added 1' }))

    expect([...result.current.state.touchedNodeIds]).toEqual(['c'])
    expect(result.current.state.touchedEdgeIds.size).toBe(0)
  })

  it('cancels its timers on unmount', () => {
    // A document switch is exactly when both timers are pending; firing one
    // afterwards would setState on a gone component.
    const { result, unmount } = renderHook(() => useAgentActivity())

    act(() => result.current.report(REPORT))
    unmount()

    expect(() =>
      act(() => {
        vi.advanceTimersByTime(AGENT_PRESENCE_MS * 2)
      }),
    ).not.toThrow()
  })
})
