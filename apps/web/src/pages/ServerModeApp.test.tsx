/**
 * A fresh server keeper's first person signs in to no workspaces. The app is
 * the only door the keeper's image ships, so it has to be able to make one:
 * the keeper makes the caller the first member and owner.
 *
 * The daemon is the shared fake, so the request body is checked against the
 * daemon-client contract (`createWorkspaceRequestSchema`) rather than against
 * a shape this test wrote down.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  options: {
    at?: string
    onPatch?: (url: string, body: unknown) => Response
    /** An answer to the workspace list that replaces the fake's, while it returns one. */
    onList?: () => Response | undefined
  } = {},
) {
  const fake = installFakeDaemonFetch({
    workspaces,
    documentsByWorkspace: {},
    ...(onCreateWorkspace === undefined ? {} : { onCreateWorkspace }),
  })
  // The fake answers the workspace routes; the session is the keeper's own.
  const { onPatch, onList } = options
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
    const listed =
      init?.method === undefined && String(input).endsWith('/api/workspaces')
        ? onList?.()
        : undefined
    return listed === undefined ? fake(input, init) : Promise.resolve(listed)
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

const lists = (fake: ReturnType<typeof installFakeDaemonFetch>) =>
  fake.mock.calls.filter(
    ([url, init]) => init?.method === undefined && String(url).endsWith('/api/workspaces'),
  )

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
      jsonResponse(
        { workspaceId: 'ws-1', namespace: 'ada', segment: 'design-team', displayName },
        201,
      ),
    )
    expect(await screen.findByText(/not a member of any workspace/i)).toBeTruthy()

    await createNamed('  Design team  ')

    await waitFor(() =>
      expect(opened.at(-1)).toMatchObject({ workspace: 'ada/design-team', serverMode: true }),
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
    await waitFor(() => expect(opened.at(-1)).toMatchObject({ workspace: 'me/plans' }))
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
    renderSignedIn([plans], undefined, { at: '/w/me/plans' })

    expect(((await screen.findByLabelText('Workspace name')) as HTMLInputElement).value).toBe(
      'Plans',
    )
    expect((screen.getByLabelText('Workspace URL') as HTMLInputElement).value).toBe('plans')
  })

  it('patches the canonical id even when the address carries the segment', async () => {
    const patches: Array<{ url: string; body: unknown }> = []
    renderSignedIn([plans], undefined, {
      at: '/w/me/plans',
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
      at: '/w/me/plans',
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
    expect(opened.at(-1)).toMatchObject({ workspace: 'me/plans' })
  })

  // The switcher beside the rename names the same workspace, so it must read
  // the rename rather than a list of its own that has not heard of it.
  const other: Workspace = { workspaceId: 'ws-2', displayName: 'Launch', segment: 'launch' }
  const pickerSummary = (name: string) => screen.findByText(name, { selector: 'summary' })

  it('names the renamed workspace in the switcher without reopening it', async () => {
    renderSignedIn([plans, other], undefined, {
      at: '/w/me/plans',
      onPatch: () =>
        jsonResponse({ workspaceId: 'ws-1', displayName: 'Roadmap', segment: 'plans' }),
    })
    await pickerSummary('Plans')

    fireEvent.change(await screen.findByLabelText('Workspace name'), {
      target: { value: 'Roadmap' },
    })

    expect(await pickerSummary('Roadmap')).toBeTruthy()
  })

  it('still names the workspace in the switcher after its address moves', async () => {
    const fake = renderSignedIn([plans, other], undefined, {
      at: '/w/me/plans',
      onPatch: () => jsonResponse({ workspaceId: 'ws-1', displayName: 'Plans', segment: 'notes' }),
    })
    await pickerSummary('Plans')

    const url = await screen.findByLabelText('Workspace URL')
    fireEvent.change(url, { target: { value: 'notes' } })
    fireEvent.keyDown(url, { key: 'Enter' })

    await waitFor(() => expect(opened.at(-1)).toMatchObject({ workspace: 'me/notes' }))
    expect(await pickerSummary('Plans')).toBeTruthy()
    // Moving the address is not a reason to list again: a re-list racing the
    // rename is how the switcher lost the row it had just renamed.
    expect(lists(fake)).toHaveLength(1)
  })
})

describe('a workspace list that fails to load offers a retry', () => {
  const plans: Workspace = { workspaceId: 'ws-1', displayName: 'Plans', segment: 'plans' }
  const other: Workspace = { workspaceId: 'ws-2', displayName: 'Launch', segment: 'launch' }

  function failingOnce() {
    let failures = 1
    return () => (failures-- > 0 ? jsonResponse({ error: 'database_busy' }, 503) : undefined)
  }

  it('on the workspaces page, and lists them once the keeper answers', async () => {
    renderSignedIn([plans], undefined, { onList: failingOnce() })

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not load your workspaces/i,
    )
    expect(screen.queryByText(/reload/i)).toBeNull()
    await expectLoggedFailure('could not list the workspaces')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('link', { name: 'Plans' })).toBeTruthy()
  })

  it('in the shell, rather than leaving the switcher out', async () => {
    renderSignedIn([plans, other], undefined, { at: '/w/me/plans', onList: failingOnce() })

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not load your workspaces/i,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Plans', { selector: 'summary' })).toBeTruthy()
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
    renderSession('/w/me/plans', failedReads['a 503'] as () => Promise<Response>)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    await expectLoggedFailure('could not read the session')
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  })

  it('still sends a browser the keeper says is signed out to sign in', async () => {
    renderSession('/w/me/plans', () => Promise.resolve(jsonResponse({ signedIn: false })))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })
})

function held<T>() {
  let answer: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    answer = resolve
  })
  return { promise, answer }
}

describe('a session read answers for the read it belongs to', () => {
  it('goes back to loading while a retried read is in flight', async () => {
    const answer = renderSession('/', failedReads['a 503'] as () => Promise<Response>)
    const retry = await screen.findByRole('button', { name: 'Try again' })
    await expectLoggedFailure('could not read the session')

    const second = held<Response>()
    answer.session = () => second.promise
    fireEvent.click(retry)

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    second.answer(await signedInAnswer())
    expect(await screen.findByRole('heading', { name: 'Your workspaces' })).toBeTruthy()
  })

  it('keeps the newer answer when an earlier read lands after it', async () => {
    const fake = installFakeDaemonFetch({ workspaces: [], documentsByWorkspace: {} })
    const sessionAs = (displayName: string) =>
      jsonResponse({ signedIn: true, user: { userId: 'u-1', displayName, administrator: false } })
    const first = held<Response>()
    const late = sessionAs('Ada')
    const keeper = (session: () => Promise<Response>) =>
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === '/auth/session' ? session() : fake(input, init),
      )
    const app = (fetchFn: typeof globalThis.fetch) => (
      <MemoryRouter initialEntries={['/']}>
        <ServerModeApp fetchFn={fetchFn} />
      </MemoryRouter>
    )
    const { rerender } = render(app(keeper(() => first.promise)))
    rerender(app(keeper(() => Promise.resolve(sessionAs('Bob')))))
    expect(await screen.findByText('Signed in as Bob')).toBeTruthy()

    await act(async () => first.answer(late))
    await vi.waitFor(() => expect(late.bodyUsed).toBe(true))
    // The read finishes in microtasks once its body is read; one macrotask drains them.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

    expect(screen.getByText('Signed in as Bob')).toBeTruthy()
    expect(screen.queryByText('Signed in as Ada')).toBeNull()
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

// A keeper with no browser sign-in mounts no `/auth` routes and answers them
// 404. That is "nobody can sign in here", not a read that failed: no retry,
// and no contract-drift record.
describe('a keeper with no sign-in routes', () => {
  function renderWithoutSignIn(at: string) {
    const fetchFn = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).startsWith('/auth/')
          ? jsonResponse(
              { error: 'not_found', message: `No route answers GET ${String(input)}` },
              404,
            )
          : jsonResponse({ error: 'unexpected' }, 500),
      ),
    )
    render(
      <MemoryRouter initialEntries={[at]}>
        <ServerModeApp fetchFn={fetchFn} />
      </MemoryRouter>,
    )
  }

  it('says no provider is configured on the sign-in page', async () => {
    renderWithoutSignIn('/sign-in')

    expect(await screen.findByText(/no sign-in provider configured/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('reads the workspaces page as signed out, and sends it to sign in', async () => {
    renderWithoutSignIn('/')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(await screen.findByText(/no sign-in provider configured/i)).toBeTruthy()
  })
})
