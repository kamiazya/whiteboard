/**
 * Removing a person from a workspace ends their access at once (ADR-0041's L1
 * removal), so the list asks first, sends the removal only on confirm, and
 * then tells the person what happened where focus lands — the row they
 * clicked in is gone.
 */
import {
  workspacePeopleApiUrl,
  workspacePersonApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { type WorkspacePerson, workspacePeople } from '../../lib/server-people.js'
import { WorkspacePeopleList } from './WorkspacePeopleList.js'

afterEach(cleanup)

type ListOutcome = Awaited<ReturnType<typeof workspacePeople.list>>

const ada: WorkspacePerson = {
  userId: 'u-ada',
  displayName: 'Ada',
  role: 'owner',
  deactivated: false,
}
const bob: WorkspacePerson = {
  userId: 'u-bob',
  displayName: 'Bob',
  role: 'member',
  deactivated: false,
}

/** A keeper that lists ws-1's people and removes one on DELETE. */
function fakeKeeper(people: WorkspacePerson[], canManage = true) {
  const listed = [...people]
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === workspacePeopleApiUrl('ws-1')) return Response.json({ people: listed, canManage })
    const person = listed.find((p) => workspacePersonApiUrl('ws-1', p.userId) === url)
    if (person !== undefined && init?.method === 'DELETE') {
      listed.splice(listed.indexOf(person), 1)
      return Response.json({ removed: true })
    }
    return Response.json({ error: 'not_found', message: 'no such route' }, { status: 404 })
  })
}

const deletes = (fetchFn: ReturnType<typeof fakeKeeper>) =>
  fetchFn.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => String(url))

describe('removing a person from a workspace', () => {
  it('sends the removal on confirm, closes the dialog and focuses the status', async () => {
    const fetchFn = fakeKeeper([ada, bob])
    render(<WorkspacePeopleList fetchFn={fetchFn} workspaceId="ws-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bob' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain(DESTRUCTIVE_COPY['remove-member']('Bob'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Bob was removed.'))
    expect(deletes(fetchFn)).toEqual([workspacePersonApiUrl('ws-1', 'u-bob')])
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('status')))
    expect(screen.queryByText('Bob')).toBeNull()
  })

  it('sends nothing on cancel, and puts focus back on the row button', async () => {
    const fetchFn = fakeKeeper([ada, bob])
    render(<WorkspacePeopleList fetchFn={fetchFn} workspaceId="ws-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bob' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Bob' })),
    )
    expect(deletes(fetchFn)).toEqual([])
    expect(screen.getByRole('status').textContent).toBe('')
  })
})

describe('what the workspace people list shows', () => {
  it('labels an owner, a member and a deactivated person', async () => {
    const cy: WorkspacePerson = {
      userId: 'u-cy',
      displayName: 'Cy',
      role: 'member',
      deactivated: true,
    }
    render(<WorkspacePeopleList fetchFn={fakeKeeper([ada, bob, cy])} workspaceId="ws-1" />)

    const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement
    expect((await row('Ada')).textContent).toContain('Owner')
    expect((await row('Bob')).textContent).toContain('Member')
    expect((await row('Cy')).textContent).toContain('Member · Deactivated')
  })

  it('says so when no one has been added yet', async () => {
    render(<WorkspacePeopleList fetchFn={fakeKeeper([])} workspaceId="ws-1" />)

    expect(await screen.findByText('No one has been added to this workspace yet.')).toBeTruthy()
  })

  it('shows a failed read as an alert', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<WorkspacePeopleList fetchFn={fetchFn} workspaceId="ws-1" />)

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i)
  })

  it('keeps the newer workspace when an older list answers late', async () => {
    let answerFirst: (outcome: ListOutcome) => void = () => {}
    const first = new Promise<ListOutcome>((resolve) => {
      answerFirst = resolve
    })
    const cy: WorkspacePerson = {
      userId: 'u-cy',
      displayName: 'Cy',
      role: 'owner',
      deactivated: false,
    }
    // Held at the list call itself, so the late answer lands inside one act
    // rather than after a body read nothing here could wait on.
    const list = vi
      .spyOn(workspacePeople, 'list')
      .mockImplementation((_fetchFn, workspaceId) =>
        workspaceId === 'ws-1'
          ? first
          : Promise.resolve({ ok: true, value: { people: [cy], canManage: false } }),
      )
    try {
      const fetchFn = fakeKeeper([])
      const { rerender } = render(<WorkspacePeopleList fetchFn={fetchFn} workspaceId="ws-1" />)
      rerender(<WorkspacePeopleList fetchFn={fetchFn} workspaceId="ws-2" />)
      expect(await screen.findByText('Cy')).toBeTruthy()

      await act(async () => {
        answerFirst({ ok: true, value: { people: [bob], canManage: false } })
        await first
      })

      expect(list).toHaveBeenCalledTimes(2)
      expect(screen.getByText('Cy')).toBeTruthy()
      expect(screen.queryByText('Bob')).toBeNull()
    } finally {
      list.mockRestore()
    }
  })
})
