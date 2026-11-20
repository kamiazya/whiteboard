import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserWorkspaceRecords } from '../lib/browser-workspace-records.js'
import { leaseOf } from '../test-utils/replica-lease.js'
import { type LoadState, useReplicaRecord } from './use-replica-record.js'

const WORKSPACE_ID = '01JD0REPLICARECORDHELD0001'
const DAEMON = 'http://127.0.0.1:3098'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The hook over a record the store hands out, with the save queue's `saved` under the test's hand. */
async function heldRecord() {
  const record = await leaseOf(new LoroDoc())
  const release = vi.spyOn(record, 'release')
  vi.spyOn(BrowserWorkspaceRecords.prototype, 'open').mockResolvedValue(record)
  const landed = Promise.withResolvers<void>()
  const states: LoadState[] = []
  const props = {
    workspaceId: WORKSPACE_ID,
    daemonBaseUrl: DAEMON,
    attempt: 0,
    withheld: undefined,
    setState: (state: LoadState) => {
      states.push(state)
    },
    saved: () => landed.promise,
  }
  const hook = renderHook((next: typeof props) => useReplicaRecord(next), { initialProps: props })
  await waitFor(() => expect(states.at(-1)?.kind).toBe('ready'))
  return { hook, props, release, landed }
}

it('keeps the record it held through a reconnect until its edits have landed', async () => {
  const { hook, props, release, landed } = await heldRecord()
  hook.rerender({ ...props, attempt: 1 })
  // The queue has not said the edits landed: a retry still needs the record.
  await Promise.resolve()
  expect(release).not.toHaveBeenCalled()

  landed.resolve()
  await waitFor(() => expect(release).toHaveBeenCalledTimes(1))
})
