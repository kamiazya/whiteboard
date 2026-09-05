/**
 * The judgement over the persistence facts, with a clock: nothing while an
 * edit is unsaved for the ordinary few hundred milliseconds, `stuck` once it
 * has been unsaved for STUCK_AFTER_MS, `failed` the moment a write is
 * refused, and back to `ok` when the store catches up. This is the whole of
 * what the shell mark says about a browser-kept document.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import { STUCK_AFTER_MS } from '../lib/storage-health.js'
import { useStorageHealth } from './useStorageHealth.js'

const saved: BrowserPersistenceState = { kind: 'saved', lastSavedAt: '2026-09-05T10:32:00.000Z' }
const pending: BrowserPersistenceState = { kind: 'pending', lastSavedAt: null }
const degraded: BrowserPersistenceState = {
  kind: 'degraded',
  reason: 'write-failed',
  message: 'The last write to this browser failed.',
  lastSavedAt: null,
}

// Props typed explicitly: a `const saved: BrowserPersistenceState` is narrowed
// to its initializer's `kind`, and renderHook would otherwise infer the props
// from it and refuse every later rerender with a different kind.
function mount(initial: BrowserPersistenceState) {
  return renderHook(({ state }: { state: BrowserPersistenceState }) => useStorageHealth(state), {
    initialProps: { state: initial },
  })
}

describe('useStorageHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is ok for a saved document and stays ok through a short unsaved spell', () => {
    const { result, rerender } = mount(saved)
    expect(result.current).toBe('ok')
    rerender({ state: pending })
    expect(result.current).toBe('ok')
    act(() => {
      vi.advanceTimersByTime(STUCK_AFTER_MS - 1)
    })
    expect(result.current).toBe('ok')
    rerender({ state: saved })
    act(() => {
      vi.advanceTimersByTime(STUCK_AFTER_MS * 2)
    })
    expect(result.current).toBe('ok')
  })

  // The clock counts from when the document BECAME unsaved, not from the
  // latest render: a page re-rendering every 100ms while typing must not
  // keep pushing the threshold away.
  it('turns stuck once the document has been unsaved for the threshold, without a re-render', () => {
    const { result, rerender } = mount(saved)
    rerender({ state: pending })
    act(() => {
      vi.advanceTimersByTime(STUCK_AFTER_MS / 2)
    })
    rerender({ state: { kind: 'saving', lastSavedAt: null } })
    act(() => {
      vi.advanceTimersByTime(STUCK_AFTER_MS / 2)
    })
    expect(result.current).toBe('stuck')
  })

  it('recovers to ok when the write lands', () => {
    const { result, rerender } = mount(pending)
    act(() => {
      vi.advanceTimersByTime(STUCK_AFTER_MS)
    })
    expect(result.current).toBe('stuck')
    rerender({ state: saved })
    expect(result.current).toBe('ok')
  })

  it('is failed at once on a refused write, and ok again once a later write lands', () => {
    const { result, rerender } = mount(pending)
    rerender({ state: degraded })
    expect(result.current).toBe('failed')
    rerender({ state: saved })
    expect(result.current).toBe('ok')
  })

  it('a document that mounts already unsaved counts from the mount', () => {
    const { result } = renderHook(() => useStorageHealth(pending))
    expect(result.current).toBe('ok')
    act(() => {
      vi.advanceTimersByTime(STUCK_AFTER_MS)
    })
    expect(result.current).toBe('stuck')
  })
})
