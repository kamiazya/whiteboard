/**
 * Deleting a cached copy, against real IndexedDB and the real settings store.
 *
 * The jsdom sibling mocks the document store, so it can only check that both
 * steps were CALLED. What decides whether a copy is actually gone is what the
 * stores hold afterwards, read back rather than inferred from the call — the
 * same rule the promote/demote path is held to.
 *
 * Two things about the arrangement are forced by the store and are worth
 * knowing before editing it.
 *
 * **Every record is seeded BEFORE any claim exists.** A workspace with a
 * registry claim is routed through the sealed store, whose key comes from a
 * daemon that is not running here, so a `save` after the claim answers
 * `ReplicaKeyWithheldError` rather than writing.
 *
 * **The neighbour that must survive carries NO claim**, for the same reason:
 * reading a claimed record back would need that key too. It is the more
 * useful control anyway — what a delete must not do is reach a record it was
 * not pointed at, and a browser-kept one is exactly the record with no
 * second copy anywhere.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BrowserWorkspaceDocs } from '../../lib/browser-workspace-docs.js'
import { withReplicaEntry } from '../../lib/replicas.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { LocalCopiesCard } from './LocalCopiesCard.js'

claimIsolatedWhiteboardDb('localcopiescard')

const KEPT = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FB2'

async function seedRecord(workspaceId: string) {
  const doc = new LoroDoc()
  doc.getMap('meta').set('workspaceId', workspaceId)
  await new BrowserWorkspaceDocs().save(workspaceId, doc)
}

function seedClaim(workspaceId: string, displayName: string) {
  createUserSettingsStore().update((current) =>
    withReplicaEntry(current, workspaceId, {
      daemonBaseUrl: 'http://127.0.0.1:3099',
      syncedAt: new Date().toISOString(),
      displayName,
    }),
  )
}

beforeEach(async () => {
  await clearWhiteboardDb()
  createUserSettingsStore().reset()
})

afterEach(() => {
  cleanup()
})

it('removes the record and the claim, and leaves an unclaimed record whole', async () => {
  await seedRecord(KEPT)
  await seedRecord(OTHER)
  // The premise, asserted rather than assumed: a delete that reports success
  // over a record that was never there proves nothing. Read while both are
  // still plaintext, since the claim below is what seals one of them.
  expect(await new BrowserWorkspaceDocs().open(KEPT)).not.toBeNull()
  expect(await new BrowserWorkspaceDocs().open(OTHER)).not.toBeNull()
  seedClaim(KEPT, 'Going away')

  render(<LocalCopiesCard settingsStore={createUserSettingsStore()} />)
  await screen.findByText('Going away')
  fireEvent.click(
    screen.getByTestId(`local-copy-${KEPT}`).querySelector('button') as HTMLButtonElement,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Delete copy' }))

  // The claim is gone, so this read takes the plaintext path again and a
  // null means the record itself was removed rather than merely unreadable.
  await waitFor(async () => {
    expect(await new BrowserWorkspaceDocs().open(KEPT)).toBeNull()
  })
  expect(createUserSettingsStore().load().storage.replicas?.[KEPT]).toBeUndefined()
  // Scoped: a delete that reached past the record it was pointed at would
  // pass every assertion above.
  expect(await new BrowserWorkspaceDocs().open(OTHER)).not.toBeNull()
})

it('leaves the record and the claim when the confirm is dismissed', async () => {
  await seedRecord(KEPT)
  seedClaim(KEPT, 'Still here')
  // Read through the CLAIM's own store rather than the plaintext path: with
  // the claim standing the record is sealed, so its presence is asserted by
  // the claim plus the record surviving the delete that did not happen.

  render(<LocalCopiesCard settingsStore={createUserSettingsStore()} />)
  await screen.findByText('Still here')
  fireEvent.click(
    screen.getByTestId(`local-copy-${KEPT}`).querySelector('button') as HTMLButtonElement,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

  expect(createUserSettingsStore().load().storage.replicas?.[KEPT]).toBeDefined()
  // And once the claim is lifted the record reads back, which is what says
  // the bytes were never touched.
  createUserSettingsStore().update((current) => ({
    ...current,
    storage: { ...current.storage, replicas: {} },
  }))
  expect(await new BrowserWorkspaceDocs().open(KEPT)).not.toBeNull()
})
