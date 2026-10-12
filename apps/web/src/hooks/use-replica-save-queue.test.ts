/**
 * The removal news drops this tab's replica mark as well as locking the page.
 *
 * Only the tab that deleted the copy drops its own mark; every other tab that
 * pulled the workspace earlier in the session still holds one, and a mark is
 * what `refuseUnlessHeld` admits a mint on once the claim is gone. A mint
 * landing between the delete and this tab hearing of it would otherwise write
 * the copy back under an id no listing names.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { isReplicaCopy, markReplica, unmarkReplica } from '../lib/replica-store.js'
import { announceWorkspaceRemoved } from '../lib/workspace-broadcast.js'
import { useReplicaSaveQueue } from './use-replica-save-queue.js'

const WORKSPACE_ID = '01JD0REPLICAQUEUEUNMARK001'
const OTHER_ID = '01JD0REPLICAQUEUEUNMARK002'
const DAEMON = 'http://127.0.0.1:3099'

afterEach(() => {
  unmarkReplica(WORKSPACE_ID)
  unmarkReplica(OTHER_ID)
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
