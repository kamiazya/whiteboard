/**
 * The inventory the card shows, and which rows may be deleted.
 *
 * The real delete — that the bytes AND the claim are both gone afterwards —
 * is `LocalCopiesCard.browser.test.tsx`, against real IndexedDB, because the
 * point of the two-step order is what survives a failure between the steps
 * and a mock cannot be wrong about that in a useful way.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { withReplicaEntry } from '../../lib/replicas.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { LocalCopiesCard } from './LocalCopiesCard.js'

const deleteDoc = vi.fn(async () => {})

const listBrowserWorkspaces = vi.fn(async () => [
  { workspaceId: 'ws-browser', segment: 'mine', displayName: 'My own board' },
])

vi.mock('../../lib/browser-workspaces.js', () => ({
  listBrowserWorkspaces: () => listBrowserWorkspaces(),
}))

vi.mock('../../lib/replica-store.js', () => ({
  openDocumentStore: () => ({ deleteDoc }),
}))

function seedReplicas() {
  const store = createUserSettingsStore()
  store.update((current) =>
    withReplicaEntry(
      withReplicaEntry(current, 'ws-cached', {
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: new Date().toISOString(),
        displayName: 'Cached board',
      }),
      'ws-open',
      {
        daemonBaseUrl: 'http://127.0.0.1:4000',
        syncedAt: new Date().toISOString(),
        displayName: 'The one open here',
      },
    ),
  )
  return store
}

beforeEach(() => {
  createUserSettingsStore().reset()
  deleteDoc.mockClear()
  listBrowserWorkspaces.mockClear()
})

afterEach(() => {
  cleanup()
})

it('lists both sets — what this browser keeps and what it has cached', async () => {
  render(<LocalCopiesCard settingsStore={seedReplicas()} />)

  // Both sets, because a list of "every copy" that omits one is worse than
  // no list: a replica has no `workspaces` row and a browser-kept workspace
  // has no registry claim, so neither source sees the other.
  expect(await screen.findByText('My own board')).toBeTruthy()
  expect(screen.getByText('Cached board')).toBeTruthy()
  expect(screen.getByText(/127\.0\.0\.1:3099/)).toBeTruthy()
})

it('offers no delete for the only copy of a browser-kept workspace', async () => {
  render(<LocalCopiesCard settingsStore={seedReplicas()} />)
  await screen.findByText('My own board')

  const row = screen.getByTestId('local-copy-ws-browser')

  // Deleting here would be data loss dressed as tidying, so the row says so
  // rather than offering a button that has to refuse.
  expect(row.querySelector('button')).toBeNull()
  expect(row.textContent).toContain('the only copy of it anywhere')
})

it('refuses to delete the copy the session is reading', async () => {
  render(<LocalCopiesCard settingsStore={seedReplicas()} workspaceId="ws-open" />)
  await screen.findByText('The one open here')

  expect(screen.getByTestId('local-copy-ws-open').querySelector('button')).toBeNull()
  // And the other one is still deletable, so the refusal is scoped rather
  // than the control being absent.
  expect(screen.getByTestId('local-copy-ws-cached').querySelector('button')).toBeTruthy()
})

it('drops the claim and the record, in that order, once the confirm is taken', async () => {
  const store = seedReplicas()
  render(<LocalCopiesCard settingsStore={store} workspaceId="ws-open" />)
  await screen.findByText('Cached board')

  fireEvent.click(
    screen.getByTestId('local-copy-ws-cached').querySelector('button') as HTMLButtonElement,
  )
  // The confirm is exercised rather than rendered: a destructive path whose
  // dialog is only asserted to exist has not been covered.
  fireEvent.click(await screen.findByRole('button', { name: 'Delete copy' }))

  await waitFor(() => {
    expect(deleteDoc).toHaveBeenCalledWith({
      docRef: { kind: 'workspace-tree', workspaceId: 'ws-cached' },
    })
  })
  expect(store.load().storage.replicas?.['ws-cached']).toBeUndefined()
  // Scoped: the other replica's claim survives.
  expect(store.load().storage.replicas?.['ws-open']).toBeDefined()
  await waitFor(() => {
    expect(screen.queryByText('Cached board')).toBeNull()
  })
})

it('keeps both the claim and the record when the confirm is cancelled', async () => {
  const store = seedReplicas()
  render(<LocalCopiesCard settingsStore={store} />)
  await screen.findByText('Cached board')

  fireEvent.click(
    screen.getByTestId('local-copy-ws-cached').querySelector('button') as HTMLButtonElement,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

  expect(deleteDoc).not.toHaveBeenCalled()
  expect(store.load().storage.replicas?.['ws-cached']).toBeDefined()
})

it('still lists the cached copies when this browser will not open its own storage', async () => {
  // The real condition, not a contrivance: a private window or blocked site
  // data refuses IndexedDB outright, and jsdom has none at all — which is
  // how this reached CI as fifteen unhandled rejections from SettingsPage's
  // own suite, where the card mounts and nothing had mocked the registry.
  listBrowserWorkspaces.mockRejectedValueOnce(new ReferenceError('indexedDB is not defined'))

  render(<LocalCopiesCard settingsStore={seedReplicas()} />)

  expect(await screen.findByText('Cached board')).toBeTruthy()
  expect(screen.getByText(/would not open its own storage/)).toBeTruthy()
  // And it says the half it could not read is missing rather than implying
  // this device keeps nothing of its own.
  expect(screen.queryByText('My own board')).toBeNull()
})
