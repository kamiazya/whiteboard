import { addMemberRequestSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../../contexts/DaemonApiContext.js'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { MembersCard } from './MembersCard.js'

afterEach(cleanup)

const WORKSPACE_ID = 'ws-1'
const MEMBERS_URL = `/api/workspaces/${WORKSPACE_ID}/members`
const CREDENTIALS_URL = '/api/pairing/credentials'

const PIN_A = {
  credentialId: 'credential-aaaaaaaa-1111',
  origin: 'https://a.example',
  backupEligible: true,
  createdAt: '2026-09-01T00:00:00.000Z',
}
const PIN_B = {
  credentialId: 'credential-bbbbbbbb-2222',
  origin: 'https://b.example',
  backupEligible: false,
  createdAt: '2026-09-02T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

function renderCard(fetchImpl: FetchImpl) {
  const fetchFn = vi.fn(fetchImpl)
  const view = render(
    <DaemonApiContext.Provider value={fetchFn as unknown as typeof globalThis.fetch}>
      <MembersCard workspaceId={WORKSPACE_ID} />
    </DaemonApiContext.Provider>,
  )
  return { fetchFn, ...view }
}

describe('MembersCard', () => {
  it('shows the empty state and offers the add form when a passkey is pinned', async () => {
    const { fetchFn } = renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) return jsonResponse({ members: [] })
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [PIN_A] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('No one has been added to this workspace yet.')
    expect(screen.getByLabelText('Passkey')).toBeTruthy()
    expect(screen.getByLabelText('Name')).toBeTruthy()

    const getCalls = fetchFn.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET')
    expect(getCalls.some(([url]) => url === MEMBERS_URL)).toBe(true)
    expect(getCalls.some(([url]) => url === CREDENTIALS_URL)).toBe(true)
  })

  it('lists each member by name and the origins of their credentials, never their profileId', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({
          members: [
            {
              profileId: 'profile/1',
              displayName: 'Ada',
              credentials: [{ credentialId: 'c1', origin: 'https://a.example' }],
              createdAt: '2026-09-01T00:00:00.000Z',
            },
            {
              profileId: 'profile-2',
              displayName: 'Grace',
              credentials: [
                { credentialId: 'c2', origin: 'https://b.example' },
                { credentialId: 'c3', origin: 'https://c.example' },
              ],
              createdAt: '2026-09-02T00:00:00.000Z',
            },
          ],
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('Ada')
    expect(screen.getByText('Grace')).toBeTruthy()
    const graceRow = screen.getByTestId('member-profile-2')
    expect(graceRow.textContent).toContain('https://b.example')
    expect(graceRow.textContent).toContain('https://c.example')

    expect(screen.queryByText('profile/1')).toBeNull()
    expect(screen.queryByText('profile-2')).toBeNull()
  })

  it('shows an error state when the members body does not parse', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({
          members: [{ displayName: 'X', credentials: [], createdAt: '2026-09-01T00:00:00.000Z' }],
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('Could not load the members of this workspace.')
    expect(screen.queryByText('X')).toBeNull()
  })

  it('shows an error state when the members list is refused', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({ error: 'unknown_workspace', message: 'no such workspace' }, 404)
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('Could not load the members of this workspace.')
  })

  it('adds a member from a chosen pin and refreshes the list', async () => {
    let members: unknown[] = []
    let postedBody: unknown
    let postedInit: RequestInit | undefined
    const { fetchFn } = renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url === MEMBERS_URL) {
        postedBody = JSON.parse(init?.body as string)
        postedInit = init
        members = [
          {
            profileId: 'profile-ada',
            displayName: 'Ada',
            credentials: [{ credentialId: PIN_B.credentialId, origin: PIN_B.origin }],
            createdAt: '2026-09-17T00:00:00.000Z',
          },
        ]
        return jsonResponse(members[0], 201)
      }
      if (method === 'GET' && url === MEMBERS_URL) return jsonResponse({ members })
      if (method === 'GET' && url === CREDENTIALS_URL)
        return jsonResponse({ credentials: [PIN_A, PIN_B] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('No one has been added to this workspace yet.')
    fireEvent.change(screen.getByLabelText('Passkey'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('Ada')
    const postCall = fetchFn.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postCall?.[0]).toBe(MEMBERS_URL)
    expect(postedInit?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(addMemberRequestSchema.parse(postedBody)).toEqual({
      credentialId: PIN_B.credentialId,
      origin: PIN_B.origin,
      displayName: 'Ada',
    })
    expect(screen.getByTestId('members-status').textContent).toMatch(/Ada was added/)
  })

  it('shows the daemon refusal inline and keeps the form when adding is refused', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url === MEMBERS_URL) {
        return jsonResponse({ error: 'unknown_credential', message: 'no pinned credential' }, 404)
      }
      if (method === 'GET' && url === MEMBERS_URL) return jsonResponse({ members: [] })
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [PIN_A] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('No one has been added to this workspace yet.')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/no pinned credential/)
    expect(screen.getByLabelText('Passkey')).toBeTruthy()
  })

  it('shows a generic message when adding fails with a non-JSON body', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url === MEMBERS_URL) {
        return new Response('oops', { status: 500 })
      }
      if (method === 'GET' && url === MEMBERS_URL) return jsonResponse({ members: [] })
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [PIN_A] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('No one has been added to this workspace yet.')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Request failed \(500\)/)
  })

  it('opens a confirm naming the member; Cancel leaves the row and issues no DELETE', async () => {
    const { fetchFn } = renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({
          members: [
            {
              profileId: 'profile-ada',
              displayName: 'Ada',
              credentials: [{ credentialId: 'c1', origin: 'https://a.example' }],
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      if (method === 'DELETE') return jsonResponse({ removed: true, sessionsEnded: 0 })
      return jsonResponse({}, 404)
    })

    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada from this workspace' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(DESTRUCTIVE_COPY['remove-member']('Ada'))).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    expect(screen.getByText('Ada')).toBeTruthy()
  })

  it('confirming the removal DELETEs the encoded profileId and drops the row', async () => {
    const profileId = 'team/ada'
    const { fetchFn } = renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({
          members: [
            {
              profileId,
              displayName: 'Ada',
              credentials: [{ credentialId: 'c1', origin: 'https://a.example' }],
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      if (method === 'DELETE' && url === `${MEMBERS_URL}/team%2Fada`) {
        return jsonResponse({ removed: true, sessionsEnded: 1 })
      }
      return jsonResponse({}, 404)
    })

    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada from this workspace' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(screen.queryAllByTestId(/^member-/).length).toBe(0))

    const deleteCall = fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(deleteCall?.[0]).toBe(`${MEMBERS_URL}/team%2Fada`)
    expect(screen.getByTestId('members-status').textContent).toMatch(/Ada was removed/)
  })

  it('shows the daemon refusal and keeps the row when removal is refused', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({
          members: [
            {
              profileId: 'profile-ada',
              displayName: 'Ada',
              credentials: [{ credentialId: 'c1', origin: 'https://a.example' }],
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      if (method === 'DELETE') {
        return jsonResponse({ error: 'unknown_profile', message: 'no such member' }, 404)
      }
      return jsonResponse({}, 404)
    })

    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada from this workspace' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByTestId('members-status').textContent).toMatch(/no such member/)
  })

  it('drops a stale response from a superseded daemon connection', async () => {
    let resolveOld: ((res: Response) => void) | undefined
    const oldFetch: FetchImpl = async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return new Promise<Response>((resolve) => {
          resolveOld = resolve
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      return jsonResponse({}, 404)
    }
    const oldFetchFn = vi.fn(oldFetch)

    const { rerender } = render(
      <DaemonApiContext.Provider value={oldFetchFn as unknown as typeof globalThis.fetch}>
        <MembersCard workspaceId={WORKSPACE_ID} />
      </DaemonApiContext.Provider>,
    )
    await waitFor(() => expect(oldFetchFn).toHaveBeenCalled())

    const newFetch: FetchImpl = async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({
          members: [
            {
              profileId: 'profile-bob',
              displayName: 'Bob',
              credentials: [],
              createdAt: '2026-09-02T00:00:00.000Z',
            },
          ],
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      return jsonResponse({}, 404)
    }

    rerender(
      <DaemonApiContext.Provider value={vi.fn(newFetch) as unknown as typeof globalThis.fetch}>
        <MembersCard workspaceId={WORKSPACE_ID} />
      </DaemonApiContext.Provider>,
    )
    await screen.findByText('Bob')

    resolveOld?.(
      jsonResponse({
        members: [
          {
            profileId: 'profile-alice',
            displayName: 'Alice',
            credentials: [],
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      }),
    )

    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull())
    expect(screen.getByText('Bob')).toBeTruthy()
  })

  it('offers no form when the browser has no pinned passkeys, and points at Connections › Passkeys', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) return jsonResponse({ members: [] })
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('No one has been added to this workspace yet.')
    expect(screen.queryByLabelText('Passkey')).toBeNull()
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByText(/Connections/)).toBeTruthy()
    expect(screen.getByText(/Passkeys/)).toBeTruthy()
  })

  it('states what removal costs in words a reader owes nothing to the internals for', async () => {
    renderCard(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === MEMBERS_URL) {
        return jsonResponse({
          members: [
            {
              profileId: 'profile-ada',
              displayName: 'Ada',
              credentials: [{ credentialId: 'c1', origin: 'https://a.example' }],
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        })
      }
      if (method === 'GET' && url === CREDENTIALS_URL) return jsonResponse({ credentials: [] })
      return jsonResponse({}, 404)
    })

    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada from this workspace' }))
    const dialog = await screen.findByRole('alertdialog')

    const cardText = `${document.body.textContent}`
    expect(cardText).not.toMatch(/revoke|revoked|\bL1\b|macaroon|profile|credential id/i)
    void dialog
  })
})
