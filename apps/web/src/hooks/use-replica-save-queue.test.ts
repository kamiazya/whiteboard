/**
 * The removal news drops this tab's replica mark as well as locking the page.
 *
 * Only the tab that deleted the copy drops its own mark; every other tab that
 * pulled the workspace earlier in the session still holds one, and a mark is
 * what `refuseUnlessHeld` admits a mint on once the claim is gone. A mint
 * landing between the delete and this tab hearing of it would otherwise write
 * the copy back under an id no listing names.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { isReplicaCopy, markReplica, unmarkReplica } from '../lib/replica-store.js'
import { announceWorkspaceRemoved } from '../lib/workspace-broadcast.js'
import { useReplicaSaveQueue } from './use-replica-save-queue.js'

const WORKSPACE_ID = '01JD0REPLICAQUEUEUNMARK001'
const OTHER_ID = '01JD0REPLICAQUEUEUNMARK002'
const DAEMON = 'http://127.0.0.1:3099'

afterEach(async () => {
  unmarkReplica(WORKSPACE_ID)
  unmarkReplica(OTHER_ID)
  // Unmounting flushes a save a failed assertion left pending; it has to land
  // in the double, not in an IndexedDB this file never set up.
  cleanup()
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A save double, and a pending save that only a flush can take out inside the test. */
function scheduledSave() {
  const save = vi.spyOn(BrowserWorkspaceDocs.prototype, 'save').mockResolvedValue(null)
  // Fake timers hold the debounce shut, so a save seen here came from the
  // page-leaving signal and not from the quiet window running out.
  vi.useFakeTimers()
  const hook = renderHook(() => useReplicaSaveQueue(WORKSPACE_ID))
  const record = new LoroDoc()
  act(() => hook.result.current.scheduleSave(record))
  return { save, record, unmount: hook.unmount }
}

it('saves a pending edit when the page unmounts', async () => {
  const { save, record, unmount } = scheduledSave()

  unmount()

  await vi.advanceTimersByTimeAsync(0)
  expect(save).toHaveBeenCalledWith(WORKSPACE_ID, record)
})

it('stops listening for page-leaving signals once unmounted', () => {
  const spies = [window, document].map((target) => ({
    add: vi.spyOn(target, 'addEventListener'),
    remove: vi.spyOn(target, 'removeEventListener'),
  }))
  const { unmount } = renderHook(() => useReplicaSaveQueue(WORKSPACE_ID))
  unmount()

  const handlers = (spy: (typeof spies)[number]['add'], type: string) =>
    spy.mock.calls.filter(([name]) => name === type).map(([, handler]) => handler)
  const [onWindow, onDocument] = spies
  for (const [spy, type] of [
    [onWindow, 'pagehide'],
    [onDocument, 'visibilitychange'],
  ] as const) {
    expect(handlers(spy.add, type)).toHaveLength(1)
    expect(handlers(spy.remove, type)).toEqual(handlers(spy.add, type))
  }
})

it('saves a pending edit when the page is hidden away', async () => {
  const { save, record } = scheduledSave()

  window.dispatchEvent(new Event('pagehide'))

  // Zero ms: runs the queue's promise chain, never the debounce. (`vi.waitFor`
  // would advance fake timers on each check and let the debounce answer.)
  await vi.advanceTimersByTimeAsync(0)
  expect(save).toHaveBeenCalledWith(WORKSPACE_ID, record)
})

it('saves a pending edit when the tab turns hidden, and not when it turns visible', async () => {
  const { save, record } = scheduledSave()
  const visibility = vi.spyOn(document, 'visibilityState', 'get')

  visibility.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(save).not.toHaveBeenCalled()

  visibility.mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(save).toHaveBeenCalledWith(WORKSPACE_ID, record)
})

it('drops the replica mark when the copy is removed in another tab', async () => {
  markReplica(WORKSPACE_ID, DAEMON)
  markReplica(OTHER_ID, DAEMON)
  const { result, unmount } = renderHook(() => useReplicaSaveQueue(WORKSPACE_ID))

  act(() => announceWorkspaceRemoved(WORKSPACE_ID))

  await waitFor(() => expect(result.current.copyRemoved).toBe(true))
  expect(isReplicaCopy(WORKSPACE_ID)).toBe(false)
  // Another workspace's copy is not this one.
  expect(isReplicaCopy(OTHER_ID)).toBe(true)
  unmount()
})

it('drops a mark the tab holds with no replica page mounted for it', async () => {
  // A tab whose page moved on to another workspace no longer listens for the
  // first one's removal, and its mark would outlive the deleted copy.
  markReplica(WORKSPACE_ID, DAEMON)

  announceWorkspaceRemoved(WORKSPACE_ID)

  await waitFor(() => expect(isReplicaCopy(WORKSPACE_ID)).toBe(false))
})
