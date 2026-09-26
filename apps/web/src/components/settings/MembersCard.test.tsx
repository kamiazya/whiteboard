import { addMemberRequestSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../../contexts/DaemonApiContext.js'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { MembersCard } from './MembersCard.js'

afterEach(cleanup)

const WORKSPACE_ID = 'ws-1'
const MEMBERS_URL = `/api/workspaces/${WORKSPACE_ID}/members`
const PEOPLE_URL = `/api/workspaces/${WORKSPACE_ID}/people`
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
const ADA = { userId: 'profile ada/1', displayName: 'Ada', role: 'owner', deactivated: false }

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

/** A daemon keeping `people` and the pins, answering the way the real routes do. */
function daemon(options: { people?: object[]; pins?: object[]; canManage?: boolean } = {}) {
  const people = [...(options.people ?? [])] as { userId: string }[]
  const handler: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET'
    if (url === CREDENTIALS_URL) return jsonResponse({ credentials: options.pins ?? [PIN_A] })
    if (url === PEOPLE_URL) return jsonResponse({ people, canManage: options.canManage ?? true })
    if (method === 'DELETE' && url.startsWith(`${PEOPLE_URL}/`)) {
      const id = decodeURIComponent(url.slice(PEOPLE_URL.length + 1))
      people.splice(
        people.findIndex((p) => p.userId === id),
        1,
      )
      return jsonResponse({ removed: true })
    }
    return jsonResponse({ error: 'not_found', message: 'no such route' }, 404)
  }
  return { people, handler }
}

describe('MembersCard', () => {
  it('shows the empty state and offers the add form when a passkey is pinned', async () => {
    renderCard(daemon().handler)
    expect(await screen.findByText(/no one has been added/i)).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('lists each member by name and role, through the shared people surface', async () => {
    const { fetchFn } = renderCard(daemon({ people: [ADA] }).handler)
    expect(await screen.findByText('Ada')).toBeTruthy()
    expect(screen.getByText('Owner')).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledWith(PEOPLE_URL, undefined)
  })

  it("shows the daemon's reason when the list is refused", async () => {
    renderCard(async (url) =>
      url === PEOPLE_URL
        ? jsonResponse({ error: 'not_a_member', message: 'you are not a member' }, 403)
        : jsonResponse({ credentials: [PIN_A] }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/not a member/)
  })

  it('adds a member from a chosen pin and refreshes the list', async () => {
    const keeper = daemon({ pins: [PIN_A, PIN_B] })
    const { fetchFn } = renderCard(async (url, init) => {
      if (url === MEMBERS_URL && init?.method === 'POST') {
        const request = addMemberRequestSchema.parse(JSON.parse(String(init.body)))
        keeper.people.push({ ...ADA, displayName: request.displayName } as never)
        return jsonResponse(
          {
            profileId: ADA.userId,
            displayName: request.displayName,
            credentials: [{ credentialId: request.credentialId, origin: request.origin }],
            createdAt: '2026-09-03T00:00:00.000Z',
          },
          201,
        )
      }
      return keeper.handler(url, init)
    })
    fireEvent.change(await screen.findByLabelText('Passkey'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Ada was added.')).toBeTruthy()
    expect(await screen.findByText('Owner')).toBeTruthy()
    const post = fetchFn.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ origin: PIN_B.origin })
  })

  it('sends nothing while the form is incomplete — a blank or whitespace name is not an add', async () => {
    const { fetchFn } = renderCard(daemon().handler)
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '   ' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Add' }).closest('form') as HTMLFormElement)
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('shows the daemon refusal inline when adding is refused, or a generic one', async () => {
    const keeper = daemon()
    let answer: Response = jsonResponse(
      { error: 'unknown_credential', message: 'that passkey is not pinned for this origin' },
      404,
    )
    renderCard(async (url, init) =>
      url === MEMBERS_URL && init?.method === 'POST' ? answer : keeper.handler(url, init),
    )
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/not pinned/)
    answer = new Response('oops', { status: 500 })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Request failed \(500\)/),
    )
  })

  it('confirms before removing; Cancel removes nothing and Remove DELETEs the encoded id', async () => {
    const { fetchFn } = renderCard(daemon({ people: [ADA] }).handler)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Ada' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(DESTRUCTIVE_COPY['remove-member']('Ada'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    )
    expect(await screen.findByText('Ada was removed.')).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledWith(
      `${PEOPLE_URL}/${encodeURIComponent(ADA.userId)}`,
      expect.objectContaining({ method: 'DELETE' }),
    )
    await waitFor(() => expect(screen.queryByText('Ada')).toBeNull())
  })

  it('offers no change to someone the daemon does not let manage people', async () => {
    renderCard(daemon({ people: [ADA], canManage: false }).handler)
    expect(await screen.findByText('Ada')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /remove|make|add/i })).toBeNull()
  })

  it('offers no form when the daemon has no pinned passkeys, and points at Connections › Passkeys', async () => {
    renderCard(daemon({ pins: [] }).handler)
    expect(await screen.findByText(/Connections › Passkeys/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })

  // A changed fetch identity is a different daemon connection: the list the
  // previous one was still reading must not land on this one.
  it('drops a stale answer from a superseded daemon connection', async () => {
    let release: (value: Response) => void = () => {}
    const slow = new Promise<Response>((resolve) => {
      release = resolve
    })
    const first = vi.fn(async (url: string) =>
      url === PEOPLE_URL ? slow : jsonResponse({ credentials: [] }),
    )
    const view = render(
      <DaemonApiContext.Provider value={first as unknown as typeof globalThis.fetch}>
        <MembersCard workspaceId={WORKSPACE_ID} />
      </DaemonApiContext.Provider>,
    )
    const second = vi.fn(daemon({ people: [] }).handler)
    view.rerender(
      <DaemonApiContext.Provider value={second as unknown as typeof globalThis.fetch}>
        <MembersCard workspaceId={WORKSPACE_ID} />
      </DaemonApiContext.Provider>,
    )
    expect(await screen.findByText(/no one has been added/i)).toBeTruthy()
    await act(async () => {
      release(jsonResponse({ people: [ADA], canManage: true }))
      await slow
    })
    expect(screen.queryByText('Ada')).toBeNull()
  })
})
