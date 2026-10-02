import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _autoCompactTimerCountForTests,
  _inFlightAutoCompactCountForTests,
  disposeAutoCompact,
  scheduleAutoCompact,
} from './auto-compact.js'
import type { VersionStore } from './version-store.js'

const compactWorkspace = vi.hoisted(() => vi.fn())

// Only the compaction call is replaced: what is under test is WHEN the
// scheduler starts one, not what compacting does.
vi.mock('./document-store.js', () => ({
  compactWorkspace,
  setDocumentSavedListener: vi.fn(),
}))

const versionStore = {} as VersionStore

afterEach(async () => {
  await disposeAutoCompact()
  vi.useRealTimers()
  compactWorkspace.mockReset()
})

describe('scheduleAutoCompact default debounce', () => {
  /**
   * Every production caller leaves `debounceMs` unset. A write burst must be
   * coalesced over a pause long enough that a person editing continuously does
   * not trigger a compaction per pause, so the default is pinned at the
   * boundary on both sides rather than by an injected shorter value.
   */
  it('waits thirty seconds of quiet before compacting when no debounce is given', async () => {
    vi.useFakeTimers()
    compactWorkspace.mockResolvedValue({ compacted: false, reason: 'no-gain', beforeBytes: 0 })

    scheduleAutoCompact('ws-default-debounce', versionStore)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(compactWorkspace).not.toHaveBeenCalled()
    expect(_autoCompactTimerCountForTests()).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(compactWorkspace).toHaveBeenCalledTimes(1)
    expect(_autoCompactTimerCountForTests()).toBe(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(_inFlightAutoCompactCountForTests()).toBe(0)
  })
})
