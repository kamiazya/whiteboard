import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import type { PasskeyCredentials } from '../lib/passkey-attestation.js'
import { PasskeysCard } from './PasskeysCard.js'

afterEach(cleanup)

const DAEMON = 'http://127.0.0.1:3099'
const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'
const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'

const RAW_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const THIS_BROWSER = { credentialId: 'Y3JlZC10aGlz', origin: HOSTED, createdAt: 'x' }
const PINS = [
  {
    credentialId: THIS_BROWSER.credentialId,
    origin: HOSTED,
    backupEligible: true,
    createdAt: '2026-09-16T00:00:00.000Z',
  },
  {
    credentialId: 'Y3JlZC1vdGhlcg',
    origin: 'http://127.0.0.1:3099',
    backupEligible: false,
    createdAt: '2026-09-15T00:00:00.000Z',
  },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A platform authenticator that registers whatever it is asked to. */
function fakePasskey(): PasskeyCredentials {
  return {
    create: async () =>
      ({
        id: b64u(RAW_ID),
        type: 'public-key',
        rawId: RAW_ID.buffer,
        response: {
          getPublicKey: () => Uint8Array.from([48, 89, 48, 19]).buffer,
          getAuthenticatorData: () => new Uint8Array(37).buffer,
        },
      }) as unknown as Credential,
    get: async () => null,
  }
}

function renderCard(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  credentials: PasskeyCredentials | null = fakePasskey(),
) {
  const fetchFn = vi.fn(fetchImpl)
  render(
    <DaemonApiContext.Provider value={fetchFn as unknown as typeof globalThis.fetch}>
      <PasskeysCard daemonBaseUrl={DAEMON} passkeyCredentials={credentials} />
    </DaemonApiContext.Provider>,
  )
  return fetchFn
}

beforeEach(() => {
  // Only this module's key: a blanket clear() would wipe theme and view-mode
  // state out from under concurrently running files.
  localStorage.removeItem(PASSKEYS_KEY)
})

describe('PasskeysCard', () => {
  it('lists each pinned passkey, and says which are confined to one device', async () => {
    renderCard(async () => jsonResponse({ credentials: PINS }))

    await screen.findByText(HOSTED)
    expect(screen.getByText('http://127.0.0.1:3099')).not.toBeNull()
    const card = screen.getByTestId('passkeys-card')
    expect(card.textContent).toMatch(/synced across your devices/i)
    expect(card.textContent).toMatch(/only on this device/i)
  })

  it('marks the passkey this browser will confirm a move with', async () => {
    localStorage.setItem(
      PASSKEYS_KEY,
      JSON.stringify({ [DAEMON]: { credentialId: THIS_BROWSER.credentialId, registeredAt: 'x' } }),
    )
    renderCard(async () => jsonResponse({ credentials: PINS }))

    const row = await screen.findByTestId(`passkey-${THIS_BROWSER.credentialId}`)
    expect(row.textContent).toMatch(/this browser/i)
    // The other daemon-origin pin is somebody else's and says nothing.
    expect(screen.getByTestId('passkey-Y3JlZC1vdGhlcg').textContent).not.toMatch(/this browser/i)
  })

  it('revokes a passkey and removes its row', async () => {
    const fetchFn = renderCard(async (_url, init) => {
      if (init?.method === 'DELETE') return jsonResponse({ revoked: true })
      return jsonResponse({ credentials: PINS })
    })

    await screen.findByText(HOSTED)
    fireEvent.click(
      screen.getByRole('button', { name: `Remove the passkey registered from ${HOSTED}` }),
    )
    await waitFor(() => {
      expect(screen.queryByText(HOSTED)).toBeNull()
    })
    const deleteCall = fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(deleteCall?.[0]).toBe(`/api/pairing/credentials/${THIS_BROWSER.credentialId}`)
    // The other pin stays.
    expect(screen.getByText('http://127.0.0.1:3099')).not.toBeNull()
  })

  it('revoking the passkey this browser uses also forgets it here', async () => {
    localStorage.setItem(
      PASSKEYS_KEY,
      JSON.stringify({ [DAEMON]: { credentialId: THIS_BROWSER.credentialId, registeredAt: 'x' } }),
    )
    renderCard(async (_url, init) => {
      if (init?.method === 'DELETE') return jsonResponse({ revoked: true })
      return jsonResponse({ credentials: PINS })
    })

    await screen.findByText(HOSTED)
    fireEvent.click(
      screen.getByRole('button', { name: `Remove the passkey registered from ${HOSTED}` }),
    )
    await waitFor(() => {
      expect(screen.queryByText(HOSTED)).toBeNull()
    })
    // Otherwise the next move names a credential the daemon no longer holds.
    expect(JSON.parse(localStorage.getItem(PASSKEYS_KEY) ?? '{}')[DAEMON]).toBeUndefined()
  })

  it('registers a passkey here and shows the daemon it was pinned on', async () => {
    let pinned = false
    renderCard(async (url, init) => {
      if (init?.method === 'POST') {
        pinned = true
        return jsonResponse(
          {
            credentialId: b64u(RAW_ID),
            origin: HOSTED,
            backupEligible: true,
            createdAt: '2026-09-17T00:00:00.000Z',
          },
          201,
        )
      }
      expect(url).toMatch(/\/api\/pairing\/credentials$/)
      return jsonResponse({
        credentials: pinned
          ? [
              {
                credentialId: b64u(RAW_ID),
                origin: HOSTED,
                backupEligible: true,
                createdAt: '2026-09-17T00:00:00.000Z',
              },
            ]
          : [],
      })
    })

    await screen.findByText(/no passkey is registered/i)
    fireEvent.click(screen.getByTestId('passkeys-register'))

    const row = await screen.findByTestId(`passkey-${b64u(RAW_ID)}`)
    expect(row.textContent).toMatch(/this browser/i)
  })

  it('says a registration was refused instead of leaving the button spinning', async () => {
    renderCard(async (_url, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ error: 'registration_rejected', message: 'rpIdHash' }, 400)
      }
      return jsonResponse({ credentials: [] })
    })

    await screen.findByText(/no passkey is registered/i)
    fireEvent.click(screen.getByTestId('passkeys-register'))

    await waitFor(() => {
      expect(screen.getByTestId('passkeys-status').textContent).toMatch(/could not register/i)
    })
    expect((screen.getByTestId('passkeys-register') as HTMLButtonElement).disabled).toBe(false)
  })

  it('offers no registration where the browser has no passkeys, and says so', async () => {
    renderCard(async () => jsonResponse({ credentials: [] }), null)

    await screen.findByText(/cannot use passkeys/i)
    expect(screen.queryByTestId('passkeys-register')).toBeNull()
  })

  it('states what losing a passkey costs, in words a reader owes nothing to the internals for', async () => {
    renderCard(async () => jsonResponse({ credentials: PINS }))

    await screen.findByText(HOSTED)
    const card = screen.getByTestId('passkeys-card')
    // Past evidence survives; only future confirmations need a passkey.
    expect(card.textContent).toMatch(/already confirmed stay verified/i)
    expect(card.textContent).not.toMatch(/loro|crdt|oplog|snapshot|webauthn|credential id/i)
  })
})
