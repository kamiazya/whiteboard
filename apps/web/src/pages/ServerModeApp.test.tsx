/**
 * A fresh server keeper's first person signs in to no workspaces. The app is
 * the only door the keeper's image ships, so it has to be able to make one:
 * the keeper makes the caller the first member and owner.
 *
 * The daemon is the shared fake, so the request body is checked against the
 * daemon-client contract (`createWorkspaceRequestSchema`) rather than against
 * a shape this test wrote down.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeDaemonFetch } from '../test-utils/fake-daemon-fetch.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { ServerModeApp } from './ServerModeApp.js'

const opened: Record<string, unknown>[] = []
vi.mock('./DaemonIndexPage.js', () => ({
  DaemonIndexPage: (props: Record<string, unknown>) => {
    opened.push(props)
    return <p>workspace index</p>
  },
}))

afterEach(() => {
  cleanup()
  opened.length = 0
  vi.unstubAllGlobals()
})

type Workspace = { workspaceId: string; displayName?: string; segment?: string }

function renderSignedIn(
  workspaces: Workspace[],
  onCreateWorkspace?: (displayName: string) => unknown,
) {
  const fake = installFakeDaemonFetch({
    workspaces,
    documentsByWorkspace: {},
    ...(onCreateWorkspace === undefined ? {} : { onCreateWorkspace }),
  })
  // The fake answers the workspace routes; the session is the keeper's own.
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/auth/session'
      ? Promise.resolve(
          jsonResponse({
            signedIn: true,
            user: { userId: 'u-1', displayName: 'Ada', administrator: false },
          }),
        )
      : fake(input, init),
  )
  render(
    <MemoryRouter initialEntries={['/']}>
      <ServerModeApp fetchFn={fetchFn} />
    </MemoryRouter>,
  )
  return fake
}

const posts = (fake: ReturnType<typeof installFakeDaemonFetch>) =>
  fake.mock.calls.filter(([, init]) => init?.method === 'POST')

async function createNamed(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'New workspace' }))
  fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
}

describe('the server-mode workspaces page creates a workspace', () => {
  it('offers it to a person with no workspaces, posts the name, and opens the result by its address', async () => {
    const fake = renderSignedIn([], (displayName) =>
      jsonResponse({ workspaceId: 'ws-1', segment: 'design-team', displayName }, 201),
    )
    expect(await screen.findByText(/not a member of any workspace/i)).toBeTruthy()

    await createNamed('  Design team  ')

    await waitFor(() =>
      expect(opened.at(-1)).toMatchObject({ workspace: 'design-team', serverMode: true }),
    )
    const [[url, init]] = posts(fake)
    expect(String(url)).toMatch(/\/api\/workspaces$/)
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: 'Design team' })
  })

  it('opens the workspace by its id when the keeper derived no address', async () => {
    renderSignedIn([], (displayName) => jsonResponse({ workspaceId: 'ws-9', displayName }, 201))

    await createNamed('Plans')

    await waitFor(() => expect(opened.at(-1)).toMatchObject({ workspace: 'ws-9' }))
  })

  it('is still offered beside workspaces the person already has', async () => {
    renderSignedIn([{ workspaceId: 'ws-1', displayName: 'Plans', segment: 'plans' }])

    expect(await screen.findByText('Plans')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeTruthy()
  })

  it('moves focus into the name box, and back to the button on Cancel', async () => {
    renderSignedIn([])

    fireEvent.click(await screen.findByRole('button', { name: 'New workspace' }))
    expect(document.activeElement).toBe(screen.getByLabelText('New workspace name'))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New workspace' })),
    )
  })

  it('says a session that names no person was refused, and that nothing was created', async () => {
    const fake = renderSignedIn([], () =>
      jsonResponse({ error: 'requires_person_session', message: 'no person on this session' }, 403),
    )

    await createNamed('Plans')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/not signed in as a person/i)
    expect(alert.textContent).toMatch(/nothing was created/i)
    expect(opened).toHaveLength(0)
    expect(posts(fake)).toHaveLength(1)
    // The form stays, with what was typed, so the person can retry.
    expect((screen.getByLabelText('New workspace name') as HTMLInputElement).value).toBe('Plans')
  })

  it('does not post twice for one submit', async () => {
    const fake = renderSignedIn([], () => new Promise<Response>(() => {}))

    await createNamed('Plans')
    fireEvent.submit(screen.getByLabelText('New workspace name'))

    await waitFor(() => expect(posts(fake)).toHaveLength(1))
  })
})
