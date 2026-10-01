/**
 * "Make readable offline" on a daemon-kept copy (ADR-0050 decision 11), in a
 * real browser: real localStorage, real WebCrypto wrapping, and the row's four
 * states — available, unavailable while the daemon is away, readable offline,
 * and turned off again.
 *
 * WebAuthn itself is the one double: a test cannot answer a real passkey
 * prompt, so `navigator.credentials` is stood in for by an authenticator whose
 * `prf` is a stable function of (credential, salt), the way a real one is. The
 * read-plane smoke drives Chromium's virtual authenticator for the real thing.
 */

import { forgetAll } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../../contexts/DaemonApiContext.js'
import { unlockReplicaKey } from '../../lib/replica-unlock.js'
import { withReplicaEntry } from '../../lib/replicas.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { LocalCopiesCard } from './LocalCopiesCard.js'

claimIsolatedWhiteboardDb('localcopiescard-offline')

const DAEMON = 'https://daemon.whiteboard.invalid'
const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FC1'
const RAW_ID = Uint8Array.from([9, 8, 7, 6])

const daemonFetch = (async () =>
  new Response(
    JSON.stringify({
      workspaceKey: bytesToBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
      workspaceKeySalt: bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)),
      tier: 'offline',
    }),
    { status: 200 },
  )) as typeof fetch

function saltOf(options: CredentialCreationOptions | CredentialRequestOptions | undefined) {
  const first = (options?.publicKey?.extensions as { prf?: { eval?: { first?: BufferSource } } })
    ?.prf?.eval?.first
  return new Uint8Array(first as ArrayBuffer)
}

async function prfCredential(salt: Uint8Array): Promise<Credential> {
  const first = await crypto.subtle.digest('SHA-256', new Uint8Array([...RAW_ID, ...salt]))
  return {
    rawId: RAW_ID.buffer,
    getClientExtensionResults: () => ({ prf: { enabled: true, results: { first } } }),
  } as unknown as Credential
}

function standInAuthenticator() {
  vi.spyOn(navigator.credentials, 'create').mockImplementation(async (options) =>
    prfCredential(saltOf(options)),
  )
  return vi
    .spyOn(navigator.credentials, 'get')
    .mockImplementation(async (options) => prfCredential(saltOf(options)))
}

function renderCard(connected: boolean) {
  return render(
    <DaemonApiContext.Provider value={connected ? daemonFetch : null}>
      <LocalCopiesCard
        settingsStore={createUserSettingsStore()}
        {...(connected ? { daemonBaseUrl: DAEMON } : {})}
      />
    </DaemonApiContext.Provider>,
  )
}

const row = () => screen.getByTestId(`local-copy-offline-${WORKSPACE}`)

beforeEach(async () => {
  await clearWhiteboardDb()
  localStorage.removeItem('whiteboard:replica-sealed-keys')
  localStorage.removeItem('whiteboard:replica-offline-passkeys')
  createUserSettingsStore().reset()
  createUserSettingsStore().update((current) =>
    withReplicaEntry(current, WORKSPACE, {
      daemonBaseUrl: DAEMON,
      syncedAt: new Date().toISOString(),
      displayName: 'Field notes',
    }),
  )
  forgetAll()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  forgetAll()
})

it('says why the action waits while the daemon is not connected', async () => {
  renderCard(false)
  await screen.findByText('Field notes')

  const button = within(row()).getByRole('button', { name: 'Make readable offline' })
  expect(button).toHaveProperty('disabled', true)
  expect(row().textContent).toContain('Available while the daemon that keeps this workspace')
})

it('makes the copy readable offline, and the unlock then opens it', async () => {
  const get = standInAuthenticator()
  renderCard(true)
  await screen.findByText('Field notes')

  const button = within(row()).getByRole('button', { name: 'Make readable offline' })
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)

  await waitFor(() => expect(row().textContent).toContain('Readable offline with your passkey.'))
  // The row's claim is checked against the unlock itself, with no daemon.
  get.mockClear()
  expect(await unlockReplicaKey({ daemonBaseUrl: DAEMON, workspaceId: WORKSPACE })).toEqual({
    ok: true,
    tier: 'offline',
  })
  expect(get).toHaveBeenCalledTimes(1)
})

it('turns it off, dropping the wrapped key', async () => {
  standInAuthenticator()
  renderCard(true)
  await screen.findByText('Field notes')
  fireEvent.click(within(row()).getByRole('button', { name: 'Make readable offline' }))
  await waitFor(() => within(row()).getByRole('button', { name: 'Turn off' }))

  fireEvent.click(within(row()).getByRole('button', { name: 'Turn off' }))

  await waitFor(() => within(row()).getByRole('button', { name: 'Make readable offline' }))
  expect(localStorage.getItem('whiteboard:replica-sealed-keys') ?? '{}').toBe('{}')
  expect(await unlockReplicaKey({ daemonBaseUrl: DAEMON, workspaceId: WORKSPACE })).toEqual({
    ok: false,
    reason: 'no-blob',
  })
})

it('deleting the copy drops its wrapped key too', async () => {
  standInAuthenticator()
  renderCard(true)
  await screen.findByText('Field notes')
  fireEvent.click(within(row()).getByRole('button', { name: 'Make readable offline' }))
  await waitFor(() => within(row()).getByRole('button', { name: 'Turn off' }))

  fireEvent.click(
    within(screen.getByTestId(`local-copy-${WORKSPACE}`)).getByRole('button', {
      name: 'Delete copy',
    }),
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Delete copy' }))

  await waitFor(() => expect(screen.queryByTestId(`local-copy-${WORKSPACE}`)).toBeNull())
  expect(localStorage.getItem('whiteboard:replica-sealed-keys') ?? '{}').toBe('{}')
  expect(localStorage.getItem('whiteboard:replica-offline-passkeys') ?? '{}').toBe('{}')
})

it('says a browser whose passkeys cannot do this cannot, and keeps nothing', async () => {
  vi.spyOn(navigator.credentials, 'create').mockResolvedValue({
    rawId: RAW_ID.buffer,
    getClientExtensionResults: () => ({ prf: { enabled: false } }),
  } as unknown as Credential)
  renderCard(true)
  await screen.findByText('Field notes')

  fireEvent.click(within(row()).getByRole('button', { name: 'Make readable offline' }))

  await waitFor(() =>
    expect(row().textContent).toContain('This browser cannot make a copy readable offline.'),
  )
  expect(localStorage.getItem('whiteboard:replica-offline-passkeys')).toBeNull()
})
