import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import {
  _autoCompactTimerCountForTests,
  _awaitAutoCompactIdleForTests,
  _inFlightAutoCompactCountForTests,
  disposeAutoCompact,
  scheduleAutoCompact,
} from './auto-compact.js'
import { storeScope } from './store-scope.js'
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

describe('scheduleAutoCompact failure and keying', () => {
  /**
   * The realistic trigger is a busy database outlasting its retry budget. A
   * rejection escaping here would be an unhandled one, raised from a timer
   * with nobody awaiting it.
   */
  it('logs a scheduled compaction that rejects as one failed warning', async () => {
    compactWorkspace.mockRejectedValue(new Error('simulated storage failure'))
    const logs = captureLogsForTests('warning')

    scheduleAutoCompact('ws-failing', versionStore, { debounceMs: 1 })
    await _awaitAutoCompactIdleForTests()
    logs.restore()

    const failures = logs.records.filter((r) => r.scope === 'auto-compact' && r.msg === 'failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.data).toMatchObject({ workspaceId: 'ws-failing' })
  })

  /**
   * `default` is a workspace id every keeper holds, so a key without the data
   * dir would let one keeper's save cancel another keeper's pending compaction.
   */
  it('keeps a pending compaction per keeper when two keepers share a workspace id', () => {
    scheduleAutoCompact('default', versionStore, {
      debounceMs: 60_000,
      scope: storeScope('/keepers/a'),
    })
    scheduleAutoCompact('default', versionStore, {
      debounceMs: 60_000,
      scope: storeScope('/keepers/b'),
    })

    expect(_autoCompactTimerCountForTests()).toBe(2)
  })
})
