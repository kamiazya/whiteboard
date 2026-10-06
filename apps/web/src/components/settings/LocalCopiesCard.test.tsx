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
import { BRIDGE_DAEMON_BASE_URL } from '../../lib/bridge-address.js'
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

const browserDocumentCounts = vi.fn(
  async (): Promise<ReadonlyMap<string, number>> => new Map([['ws-browser', 2]]),
)

vi.mock('../../lib/browser-document-counts.js', () => ({
  browserDocumentCounts: () => browserDocumentCounts(),
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
  browserDocumentCounts.mockClear()
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

it('says how much a browser-kept workspace holds', async () => {
  render(<LocalCopiesCard settingsStore={seedReplicas()} />)
  const row = await screen.findByTestId('local-copy-ws-browser')
  await waitFor(() => expect(row.textContent).toContain('2 documents'))
})

// What a demote leaves behind when it moved the last browser workspace: a
// fresh, empty "default" beside the cached replica of the daemon's own
// "default". Calling the empty one "the only copy of it anywhere" put two
// rows of one name side by side making opposite claims about nothing.
it('says an empty browser workspace is empty, not that it is the only copy of anything', async () => {
  listBrowserWorkspaces.mockResolvedValueOnce([
    { workspaceId: 'ws-fresh', segment: 'default', displayName: 'default' },
  ])
  browserDocumentCounts.mockResolvedValueOnce(new Map([['ws-fresh', 0]]))
  const store = createUserSettingsStore()
  store.update((current) =>
    withReplicaEntry(current, 'ws-daemon-default', {
      daemonBaseUrl: 'http://127.0.0.1:3099',
      syncedAt: new Date().toISOString(),
      displayName: 'default',
    }),
  )
  render(<LocalCopiesCard settingsStore={store} />)

  const fresh = await screen.findByTestId('local-copy-ws-fresh')
  await waitFor(() => expect(fresh.textContent).toMatch(/Kept in this browser.*empty/))
  expect(fresh.textContent).not.toContain('only copy')
  // The two rows of one name each say which keeper they belong to.
  expect(screen.getByTestId('local-copy-ws-daemon-default').textContent).toMatch(
    /Cached from .*127\.0\.0\.1:3099/,
  )
})

it('keeps the browser rows when their documents cannot be counted', async () => {
  browserDocumentCounts.mockRejectedValueOnce(new ReferenceError('indexedDB is not defined'))
  render(<LocalCopiesCard settingsStore={seedReplicas()} />)
  const row = await screen.findByTestId('local-copy-ws-browser')
  expect(row.textContent).toContain('the only copy of it anywhere')
  expect(row.textContent).not.toMatch(/documents?\b/)
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

// The bridge's address is reserved precisely so nothing answers it; it names
// no host a person could recognise, so a row must say what it came through.
it('names a copy kept through the extension by the extension, never its reserved address', async () => {
  const store = createUserSettingsStore()
  store.update((current) =>
    withReplicaEntry(current, 'ws-bridged', {
      daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
      syncedAt: new Date().toISOString(),
      displayName: 'Bridged board',
    }),
  )
  render(<LocalCopiesCard settingsStore={store} />)

  const row = await screen.findByTestId('local-copy-ws-bridged')
  expect(row.textContent).toMatch(/Cached from the whiteboard extension/)
  expect(row.textContent).not.toMatch(/invalid/)
})
