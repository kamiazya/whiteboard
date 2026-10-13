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
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
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
  options: { at?: string; onPatch?: (url: string, body: unknown) => Response } = {},
) {
  const fake = installFakeDaemonFetch({
    workspaces,
    documentsByWorkspace: {},
    ...(onCreateWorkspace === undefined ? {} : { onCreateWorkspace }),
  })
  // The fake answers the workspace routes; the session is the keeper's own.
  const { onPatch } = options
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/auth/session') {
      return Promise.resolve(
        jsonResponse({
          signedIn: true,
          user: { userId: 'u-1', displayName: 'Ada', administrator: false },
        }),
      )
    }
    if (onPatch !== undefined && init?.method === 'PATCH') {
      return Promise.resolve(onPatch(String(input), JSON.parse(String(init.body))))
    }
    return fake(input, init)
  })
  // Every request the app makes, the workspace switcher's included, goes out
  // on the fetch it was handed; one that reached for the global would fail here.
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('global fetch used')))
  render(
    <MemoryRouter initialEntries={[options.at ?? '/']}>
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
    let attempts = 0
    const fake = renderSignedIn([], (displayName) =>
      attempts++ === 0
        ? jsonResponse(
            { error: 'requires_person_session', message: 'no person on this session' },
            403,
          )
        : jsonResponse({ workspaceId: 'ws-2', segment: 'plans', displayName }, 201),
    )

    await createNamed('Plans')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/not signed in as a person/i)
    expect(alert.textContent).toMatch(/nothing was created/i)
    expect(opened).toHaveLength(0)
    expect(posts(fake)).toHaveLength(1)
    // The form stays, with what was typed, so the person can retry.
    expect((screen.getByLabelText('New workspace name') as HTMLInputElement).value).toBe('Plans')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(posts(fake)).toHaveLength(2))
    await waitFor(() => expect(opened.at(-1)).toMatchObject({ workspace: 'plans' }))
  })

  it('does not post twice for one submit', async () => {
    const fake = renderSignedIn([], () => new Promise<Response>(() => {}))

    await createNamed('Plans')
    fireEvent.submit(screen.getByLabelText('New workspace name'))

    await waitFor(() => expect(posts(fake)).toHaveLength(1))
  })
})

describe('the server-mode workspace shell renames the open workspace', () => {
  const plans: Workspace = { workspaceId: 'ws-1', displayName: 'Plans', segment: 'plans' }

  it('offers the name and the address of the workspace the address names', async () => {
    renderSignedIn([plans], undefined, { at: '/w/plans' })

    expect(((await screen.findByLabelText('Workspace name')) as HTMLInputElement).value).toBe(
      'Plans',
    )
    expect((screen.getByLabelText('Workspace URL') as HTMLInputElement).value).toBe('plans')
  })

  it('patches the canonical id even when the address carries the segment', async () => {
    const patches: Array<{ url: string; body: unknown }> = []
    renderSignedIn([plans], undefined, {
      at: '/w/plans',
      onPatch: (url, body) => {
        patches.push({ url, body })
        return jsonResponse({ workspaceId: 'ws-1', displayName: 'Roadmap', segment: 'plans' })
      },
    })

    fireEvent.change(await screen.findByLabelText('Workspace name'), {
      target: { value: 'Roadmap' },
    })

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]?.url).toMatch(/\/api\/workspaces\/ws-1$/)
    expect(patches[0]?.body).toEqual({ displayName: 'Roadmap' })
  })

  it("says the keeper's refusal, and leaves the address where it was", async () => {
    renderSignedIn([plans], undefined, {
      at: '/w/plans',
      onPatch: () =>
        jsonResponse(
          { error: 'segment_taken', message: 'Workspace segment "notes" is taken' },
          409,
        ),
    })

    const url = await screen.findByLabelText('Workspace URL')
    fireEvent.change(url, { target: { value: 'notes' } })
    fireEvent.keyDown(url, { key: 'Enter' })

    expect((await screen.findByRole('alert')).textContent).toMatch(/notes/)
    expect(opened.at(-1)).toMatchObject({ workspace: 'plans' })
  })
})

// What the keeper answers when it is busy (`answerUnhandled`), and what a
// reverse proxy in front of it answers when it is down.
const failedReads: Record<string, () => Promise<Response>> = {
  'a 503': () => Promise.resolve(jsonResponse({ error: 'database_busy' }, 503)),
  "a proxy's HTML 502": () =>
    Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })),
  'a rejected fetch': () => Promise.reject(new TypeError('Failed to fetch')),
}

function renderSession(at: string, session: () => Promise<Response>) {
  const fake = installFakeDaemonFetch({
    workspaces: [{ workspaceId: 'ws-1', displayName: 'Plans', segment: 'plans' }],
    documentsByWorkspace: {},
  })
  const answer = { session }
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/auth/session') return answer.session()
    if (url === '/auth/providers') return Promise.resolve(jsonResponse({ providers: [] }))
    return fake(input, init)
  })
  render(
    <MemoryRouter initialEntries={[at]}>
      <ServerModeApp fetchFn={fetchFn} />
    </MemoryRouter>,
  )
  return answer
}

const signedInAnswer = () =>
  Promise.resolve(
    jsonResponse({
      signedIn: true,
      user: { userId: 'u-1', displayName: 'Ada', administrator: false },
    }),
  )

describe('a session read that fails is not a sign-out', () => {
  for (const [name, failure] of Object.entries(failedReads)) {
    it(`offers a retry for ${name} on the workspaces page, and lands once the server answers`, async () => {
      const answer = renderSession('/', failure)

      const retry = await screen.findByRole('button', { name: 'Try again' })
      await expectLoggedFailure('could not read the session')
      expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()

      answer.session = signedInAnswer
      fireEvent.click(retry)

      expect(await screen.findByRole('heading', { name: 'Your workspaces' })).toBeTruthy()
      expect(await screen.findByText('Plans')).toBeTruthy()
    })
  }

  it('offers a retry in front of a workspace too', async () => {
    renderSession('/w/plans', failedReads['a 503'] as () => Promise<Response>)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    await expectLoggedFailure('could not read the session')
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  })

  it('still sends a browser the keeper says is signed out to sign in', async () => {
    renderSession('/w/plans', () => Promise.resolve(jsonResponse({ signedIn: false })))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })
})

describe('a sign-in provider read that fails is not "none configured"', () => {
  it('says the options could not be loaded, and lists them on retry', async () => {
    let providers = () => Promise.resolve(jsonResponse({ error: 'database_busy' }, 503))
    const fetchFn = vi.fn((input: RequestInfo | URL) =>
      String(input) === '/auth/providers'
        ? providers()
        : Promise.reject(new Error(`unexpected ${String(input)}`)),
    )
    render(
      <MemoryRouter initialEntries={['/sign-in']}>
        <ServerModeApp fetchFn={fetchFn} />
      </MemoryRouter>,
    )

    const retry = await screen.findByRole('button', { name: 'Try again' })
    await expectLoggedFailure('could not read the sign-in providers')
    expect(screen.queryByText(/no sign-in provider configured/)).toBeNull()

    providers = () =>
      Promise.resolve(jsonResponse({ providers: [{ id: 'gh', displayName: 'GitHub' }] }))
    fireEvent.click(retry)

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toBeTruthy()
  })
})
