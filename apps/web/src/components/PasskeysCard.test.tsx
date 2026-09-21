import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  // A changed `fetchApi` identity means a DIFFERENT daemon, and these pins are
  // credential ids: a stale list rendered against the current daemon offers a
  // Remove button that sends another daemon's `credentialId` to this one. Six
  // `generation !== generationRef.current` checks in the component stop that,
  // and every other case here uses a single fetch and never rerenders, so all
  // six were unreachable.
  const NEW_PIN = {
    credentialId: 'Y3JlZC1uZXctZGFlbW9u',
    origin: 'http://127.0.0.1:4099',
    backupEligible: false,
    createdAt: '2026-09-20T00:00:00.000Z',
  }

  /** A fetch the test settles by hand, either way. */
  function heldFetch() {
    let release!: (response: Response) => void
    let fail!: (reason: Error) => void
    const held = new Promise<Response>((resolve, reject) => {
      release = resolve
      fail = reject
    })
    return { release, fail, fetchFn: vi.fn(() => held) }
  }

  const provide = (fetchFn: unknown, baseUrl: string) => (
    <DaemonApiContext.Provider value={fetchFn as typeof globalThis.fetch}>
      <PasskeysCard daemonBaseUrl={baseUrl} passkeyCredentials={fakePasskey()} />
    </DaemonApiContext.Provider>
  )

  it('CONTROL: a held list released with no daemon switch DOES render', async () => {
    // Without this, the case below proves nothing: "the old daemon's pins are
    // absent" is equally true when the release simply has not been flushed
    // yet, and an absence assertion cannot tell those apart. This one shares
    // the harness and the flush, and asserts PRESENCE — so if it passes, the
    // flush reaches a setState and the absence next door is about the guard.
    const held = heldFetch()
    render(provide(held.fetchFn, DAEMON))

    await act(async () => {
      held.release(jsonResponse({ credentials: PINS }))
    })

    for (const pin of PINS) {
      expect(screen.getByTestId(`passkey-${pin.credentialId}`)).not.toBeNull()
    }
  })

  it('a list from the previous daemon never lands on the current one', async () => {
    const old = heldFetch()
    const newFetch = vi.fn(async () => jsonResponse({ credentials: [NEW_PIN] }))

    const { rerender } = render(provide(old.fetchFn, DAEMON))
    rerender(provide(newFetch, 'http://127.0.0.1:4099'))
    await screen.findByTestId(`passkey-${NEW_PIN.credentialId}`)

    // The old daemon answers last, with ITS pins.
    await act(async () => {
      old.release(jsonResponse({ credentials: PINS }))
    })

    expect(screen.getByTestId(`passkey-${NEW_PIN.credentialId}`)).not.toBeNull()
    for (const pin of PINS) {
      expect(screen.queryByTestId(`passkey-${pin.credentialId}`)).toBeNull()
    }
  })

  it('a revoke sent to the previous daemon does not remove a row from the current one', async () => {
    // `revoke` reads the generation WITHOUT incrementing it, so the switch's
    // own reload is what invalidates an in-flight DELETE.
    //
    // The new daemon's list holds the SAME credentialId, which is the only
    // arrangement that can fail: one passkey registered on both daemons. A
    // new list that shares no id with the revoked one filters to itself
    // unchanged, so the guard is unobservable — measured, that version of
    // this case survived deleting the guard outright.
    const SHARED = PINS[1]?.credentialId ?? ''
    const del = heldFetch()
    const oldFetch = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? del.fetchFn()
        : Promise.resolve(jsonResponse({ credentials: PINS })),
    )
    const newFetch = vi.fn(async () =>
      jsonResponse({
        credentials: [
          NEW_PIN,
          {
            credentialId: SHARED,
            origin: 'http://127.0.0.1:4099',
            backupEligible: false,
            createdAt: 'x',
          },
        ],
      }),
    )

    const { rerender } = render(provide(oldFetch, DAEMON))
    const row = await screen.findByTestId(`passkey-${SHARED}`)
    fireEvent.click(within(row).getByRole('button', { name: /remove/i }))

    rerender(provide(newFetch, 'http://127.0.0.1:4099'))
    await screen.findByTestId(`passkey-${NEW_PIN.credentialId}`)

    await act(async () => {
      del.release(jsonResponse({ revoked: true }))
    })

    // The current daemon still holds it; saying otherwise tells the person a
    // passkey is gone that would still be accepted.
    expect(screen.getByTestId(`passkey-${SHARED}`)).not.toBeNull()
  })

  it('a FAILED list from the previous daemon does not error out the current one', async () => {
    // The `catch` has its own generation check, and it is the one a reader
    // would notice: a stale network failure replacing a loaded list with the
    // error state says the CURRENT daemon is unreachable when it answered
    // fine a moment ago.
    const old = heldFetch()
    const newFetch = vi.fn(async () => jsonResponse({ credentials: [NEW_PIN] }))

    const { rerender } = render(provide(old.fetchFn, DAEMON))
    rerender(provide(newFetch, 'http://127.0.0.1:4099'))
    await screen.findByTestId(`passkey-${NEW_PIN.credentialId}`)

    await act(async () => {
      old.fail(new Error('the previous daemon went away'))
    })

    expect(screen.getByTestId(`passkey-${NEW_PIN.credentialId}`)).not.toBeNull()
  })

  it('a FAILED revoke on the previous daemon does not post its message here', async () => {
    const del = heldFetch()
    const oldFetch = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? del.fetchFn()
        : Promise.resolve(jsonResponse({ credentials: PINS })),
    )
    const newFetch = vi.fn(async () => jsonResponse({ credentials: [NEW_PIN] }))

    const { rerender } = render(provide(oldFetch, DAEMON))
    const row = await screen.findByTestId(`passkey-${PINS[1]?.credentialId}`)
    fireEvent.click(within(row).getByRole('button', { name: /remove/i }))

    rerender(provide(newFetch, 'http://127.0.0.1:4099'))
    await screen.findByTestId(`passkey-${NEW_PIN.credentialId}`)

    await act(async () => {
      del.fail(new Error('the previous daemon went away'))
    })

    // Naming the OLD daemon's origin in a message about the current one is
    // the whole defect: the person is told a removal failed on a daemon they
    // are no longer looking at.
    expect(screen.getByTestId('passkeys-card').textContent).not.toMatch(
      new RegExp(PINS[1]?.origin ?? 'x'),
    )
  })

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
