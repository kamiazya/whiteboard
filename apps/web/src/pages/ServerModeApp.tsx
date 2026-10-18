/**
 * The web app as a server-mode keeper serves it (ADR-0047): same origin as
 * the keeper, so signing in is a navigation to its `/auth` routes and the
 * session is the host-only cookie the browser then holds.
 *
 * Sign in, accept an invitation, see the workspaces you are a member of, make
 * one, and open one in the editor (`ServerModeWorkspace`), or sign out.
 */
import {
  authAcceptInvitationUrl,
  authProvidersUrl,
  authSessionUrl,
  authSignInUrl,
  INVITE_PAGE_PATH,
  inviteTokenOf,
  RECEIVE_TRANSFER_PAGE_PATH,
  SIGN_IN_PAGE_PATH,
  signInPageUrl,
  signInRefusalOf,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import {
  type AcceptInvitationRequest,
  acceptInvitationResponseSchema,
  type SignInProvidersResponse,
  type SignInSessionResponse,
  signInProvidersResponseSchema,
  signInRefusalSchema,
  signInSessionResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { z } from 'zod'
import { NewWorkspaceControl } from '../components/server-mode/NewWorkspaceControl.js'
import { ServerModeShell, SignOutControl } from '../components/server-mode/ServerModeShell.js'
import { Button, buttonVariants } from '../components/ui/button.js'
import { useShellWorkspaces } from '../hooks/use-shell-workspaces.js'
import { getAppLogger } from '../lib/app-logger.js'
import { type WorkspaceRoute, workspacePath, workspaceRoutePath } from '../lib/app-routes.js'
import { DaemonContractError, readDaemonJson } from '../lib/daemon-contract-error.js'
import { GENERIC_SIGN_IN_REFUSAL, SIGN_IN_REFUSAL_COPY } from '../lib/sign-in-refusal-copy.js'
import { workspaceHandle, workspaceLabel } from '../lib/workspace-handle.js'
import type { KeeperWorkspaces, WorkspaceRow } from '../lib/workspace-switcher-source.js'
import { ReceiveTransferPage } from './ReceiveTransferPage.js'
import { TenantPeoplePage, WorkspacePeoplePage } from './ServerModePeoplePage.js'
import { ServerModeWorkspace } from './ServerModeWorkspace.js'

type Fetch = typeof globalThis.fetch

/** Leaves the app for `location`: the provider, or a page the keeper serves. */
type GoTo = (location: string) => void

interface ServerModeAppProps {
  fetchFn?: Fetch
  goTo?: GoTo
}

const log = getAppLogger('server-mode')

/**
 * Reads one of the keeper's `/auth` answers, or `'unavailable'` when it could
 * not be read. A refusal or a busy keeper's 5xx carries an error body, not the
 * contract, so the status is checked before the body is parsed: otherwise every
 * 503 would be reported as client/daemon drift.
 */
async function readAuth<T>(
  fetchFn: Fetch,
  route: string,
  schema: z.ZodType<T>,
  what: string,
  absent?: T,
): Promise<T | 'unavailable'> {
  try {
    const res = await fetchFn(route)
    if (res.ok) return await readDaemonJson(route, res, schema)
    if (res.status === 404 && absent !== undefined) return absent
    log.warn(`could not read ${what}`, { route, status: res.status })
  } catch (err) {
    // Drift was already reported by the reader that built it.
    if (!(err instanceof DaemonContractError)) log.warn(`could not read ${what}`, { route, err })
  }
  return 'unavailable'
}

/**
 * One read, re-run by the returned `retry`; `undefined` while it is in flight.
 * `read` must be stable across renders, or it re-reads on every one.
 */
function useRetryableRead<T>(read: () => Promise<T>): [T | undefined, () => void] {
  const [result, setResult] = useState<{ value: T } | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setResult(undefined)
    void read().then((value) => {
      if (live) setResult({ value })
    })
    return () => {
      live = false
    }
  }, [read, attempt])
  return [result?.value, useCallback(() => setAttempt((n) => n + 1), [])]
}

function Unavailable({ message, onRetry }: Readonly<{ message: string; onRetry: () => void }>) {
  return (
    <>
      <p role="alert" className="max-w-md text-center text-sm text-destructive">
        {message}
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </>
  )
}

type Providers = SignInProvidersResponse['providers']

function useProviders(fetchFn: Fetch) {
  const read = useCallback(
    () =>
      readAuth(
        fetchFn,
        authProvidersUrl(),
        signInProvidersResponseSchema,
        'the sign-in providers',
        // A server with no provider configured mounts no sign-in routes, so
        // this route is unknown to it: that is "none", not "unreachable".
        { providers: [] },
      ).then((body): Providers | 'unavailable' => (body === 'unavailable' ? body : body.providers)),
    [fetchFn],
  )
  return useRetryableRead(read)
}

function refusalMessage(search: string): string | null {
  const error = signInRefusalOf(search)
  if (error === undefined) return null
  const reason = signInRefusalSchema.safeParse(error)
  return reason.success ? SIGN_IN_REFUSAL_COPY[reason.data] : GENERIC_SIGN_IN_REFUSAL
}

function signInHref(providerId: string): string {
  return authSignInUrl(providerId, { returnTo: '/' })
}

const providerButton = buttonVariants({ variant: 'outline', className: 'w-full' })

/**
 * Where the keeper sends the browser once this invitation is accepted, or
 * null when it could not be — kept apart from any string a keeper may answer. Accepting is this POST and never a link: a link is a
 * navigation anything can start — a page elsewhere, a link inside a document
 * here — and the keeper sends every navigation carrying an invitation back to
 * this page.
 */
async function acceptInvitation(
  fetchFn: Fetch,
  providerId: string,
  invitation: string,
): Promise<string | null> {
  const route = authAcceptInvitationUrl(providerId)
  const body: AcceptInvitationRequest = { invitation, returnTo: '/' }
  try {
    const res = await fetchFn(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return (await readDaemonJson(route, res, acceptInvitationResponseSchema)).location
    log.warn('could not accept the invitation', { route, status: res.status })
  } catch (err) {
    // Drift was already reported by the reader that built it.
    if (!(err instanceof DaemonContractError)) {
      log.warn('could not accept the invitation', { route, err })
    }
  }
  return null
}

function AcceptInvitation({
  fetchFn,
  goTo,
  provider,
  invitation,
  onUnavailable,
}: Readonly<{
  fetchFn: Fetch
  goTo: GoTo
  provider: Providers[number]
  invitation: string
  onUnavailable: () => void
}>) {
  const [busy, setBusy] = useState(false)
  // Back from the provider, the browser may restore this page from its
  // back/forward cache with `busy` still set, which would leave no way on.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false)
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [])
  const accept = async () => {
    setBusy(true)
    const location = await acceptInvitation(fetchFn, provider.id, invitation)
    if (location === null) {
      setBusy(false)
      onUnavailable()
      return
    }
    goTo(location)
  }
  return (
    <button type="button" className={providerButton} disabled={busy} onClick={() => void accept()}>
      Continue with {provider.displayName}
    </button>
  )
}

function Page({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      {children}
    </main>
  )
}

// Without an invitation each provider is a link to begin; with one, each is
// the button that accepts it.
function ProviderChoices({
  fetchFn,
  goTo,
  providers,
  invitation,
  onAcceptUnavailable,
}: Readonly<{
  fetchFn: Fetch
  goTo: GoTo
  providers: Providers
  invitation?: string
  onAcceptUnavailable: () => void
}>) {
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {providers.map((provider) => (
        <li key={provider.id}>
          {invitation === undefined ? (
            <a href={signInHref(provider.id)} className={providerButton}>
              Continue with {provider.displayName}
            </a>
          ) : (
            <AcceptInvitation
              fetchFn={fetchFn}
              goTo={goTo}
              provider={provider}
              invitation={invitation}
              onUnavailable={onAcceptUnavailable}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

function SignInPage({
  fetchFn,
  goTo,
  invitation,
}: Readonly<{
  fetchFn: Fetch
  goTo: GoTo
  invitation?: string
}>) {
  const [providers, retry] = useProviders(fetchFn)
  const [acceptFailed, setAcceptFailed] = useState(false)
  const refusal = refusalMessage(useLocation().search)
  return (
    <Page>
      <h1 className="text-xl font-semibold">
        {invitation === undefined ? 'Sign in' : 'You have been invited'}
      </h1>
      {refusal !== null && (
        <p role="alert" className="max-w-md text-center text-sm text-destructive">
          {refusal}
        </p>
      )}
      {acceptFailed && (
        <p role="alert" className="max-w-md text-center text-sm text-destructive">
          Could not accept the invitation. Try again.
        </p>
      )}
      {providers === 'unavailable' && (
        <Unavailable message="Could not load the ways to sign in." onRetry={retry} />
      )}
      {providers?.length === 0 && (
        <p className="max-w-md text-center text-sm text-muted-foreground">
          This server has no sign-in provider configured. Ask the person who runs it.
        </p>
      )}
      {providers !== 'unavailable' && providers !== undefined && (
        <ProviderChoices
          fetchFn={fetchFn}
          goTo={goTo}
          providers={providers}
          {...(invitation === undefined ? {} : { invitation })}
          onAcceptUnavailable={() => setAcceptFailed(true)}
        />
      )}
    </Page>
  )
}

// The token rides the fragment, which the browser never sends to a server
// or puts in a Referer.
function InvitePage({ fetchFn, goTo }: Readonly<{ fetchFn: Fetch; goTo: GoTo }>) {
  const token = inviteTokenOf(useLocation().hash)
  return (
    <SignInPage
      fetchFn={fetchFn}
      goTo={goTo}
      {...(token === undefined ? {} : { invitation: token })}
    />
  )
}

type SessionUser = Extract<SignInSessionResponse, { signedIn: true }>['user']

/**
 * The keeper answers a browser with no session `200 { signedIn: false }`, and
 * that alone is "signed out" — as is a 404 from a keeper with no browser
 * sign-in, which mounts no `/auth` routes, so nobody is signed in to it. Any
 * other outcome — a busy keeper's 503, a proxy's 502, no answer — says nothing
 * about the session, and reading it as signed out would send a signed-in
 * person round the sign-in loop.
 */
async function readSession(fetchFn: Fetch): Promise<SessionUser | null | 'unavailable'> {
  const session = await readAuth(
    fetchFn,
    authSessionUrl(),
    signInSessionResponseSchema,
    'the session',
    { signedIn: false },
  )
  if (session === 'unavailable') return session
  return session.signedIn ? session.user : null
}

const SESSION_UNAVAILABLE = 'Could not check whether you are signed in.'

/**
 * The person's workspaces, read through the same seam the shell switches and
 * renames through, once the session has said who they are. A list that fails
 * is not "no workspaces", and the person who is signed in can ask again.
 */
function WorkspaceList({ source }: Readonly<{ source: KeeperWorkspaces['source'] }>) {
  const read = useCallback(
    () =>
      source.list().catch((err: unknown): 'unavailable' => {
        // Drift was already reported by the reader that built it.
        if (!(err instanceof DaemonContractError))
          log.warn('could not list the workspaces', { err })
        return 'unavailable'
      }),
    [source],
  )
  const [workspaces, retry] = useRetryableRead<readonly WorkspaceRow[] | 'unavailable'>(read)
  if (workspaces === undefined) return null
  if (workspaces === 'unavailable') {
    return <Unavailable message="Could not load your workspaces." onRetry={retry} />
  }
  if (workspaces.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">You are not a member of any workspace yet.</p>
    )
  }
  return (
    <ul className="flex w-full max-w-md flex-col gap-1">
      {workspaces.map((w) => (
        <li key={w.workspaceId}>
          <Link
            to={workspacePath(workspaceHandle(w))}
            className="block rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            {workspaceLabel(w)}
          </Link>
        </li>
      ))}
    </ul>
  )
}

// The daemon shell's own workspace seam, pointed at this keeper's origin and
// sent over the app's fetch like every other request it makes: the session
// cookie authenticates. Only the keeper's half is used here; the browser's is
// built beside it and never touched.
function useKeeperWorkspaces(fetchFn: Fetch) {
  const navigate = useNavigate()
  const daemonShellTarget = useMemo(() => ({ baseUrl: window.location.origin }), [])
  // The seam is memoized on this callback and its list is read in an effect
  // keyed on the seam, while the router hands out a new `navigate` whenever
  // the address moves. Read through a ref, so moving the address — a rename
  // that changes the segment does — is not a fresh list racing the rename.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const setDaemonRoute = useCallback(
    (route: WorkspaceRoute) => navigateRef.current(workspaceRoutePath(route)),
    [],
  )
  return useShellWorkspaces({ daemonShellTarget, navigate, setDaemonRoute, fetchFn })
    .daemonWorkspaces
}

// The shell is built under the workspace route, so the seam it renames through
// is made here rather than threaded down from the app.
function OpenWorkspace({
  fetchFn,
  displayName,
}: Readonly<{ fetchFn: Fetch; displayName: string }>) {
  const workspaces = useKeeperWorkspaces(fetchFn)
  return (
    <ServerModeWorkspace
      shell={
        <ServerModeShell displayName={displayName} fetchFn={fetchFn} workspaces={workspaces} />
      }
    />
  )
}

function WorkspacesPage({ fetchFn }: { fetchFn: Fetch }) {
  const keeperWorkspaces = useKeeperWorkspaces(fetchFn)
  const read = useCallback(() => readSession(fetchFn), [fetchFn])
  const [signed, retry] = useRetryableRead(read)

  if (signed === undefined) return null
  if (signed === null) return <Navigate to={signInPageUrl()} replace />
  if (signed === 'unavailable') {
    return (
      <Page>
        <Unavailable message={SESSION_UNAVAILABLE} onRetry={retry} />
      </Page>
    )
  }

  return (
    <Page>
      <header className="flex w-full max-w-md flex-wrap items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">Signed in as {signed.displayName}</span>
        {signed.administrator && (
          <Link to="/people" className="text-sm underline">
            People on this server
          </Link>
        )}
        <SignOutControl fetchFn={fetchFn} />
      </header>
      <h1 className="text-xl font-semibold">Your workspaces</h1>
      {keeperWorkspaces !== undefined && (
        <>
          <WorkspaceList source={keeperWorkspaces.source} />
          <NewWorkspaceControl workspaces={keeperWorkspaces} />
        </>
      )}
    </Page>
  )
}

// A workspace's routes answer 401 to a browser with no session; asking first
// sends it to the sign-in screen instead of an editor that cannot load.
function SignedInOnly({
  fetchFn,
  children,
}: Readonly<{
  fetchFn: Fetch
  children: (user: SessionUser) => ReactNode
}>) {
  const read = useCallback(() => readSession(fetchFn), [fetchFn])
  const [who, retry] = useRetryableRead(read)
  if (who === undefined) return null
  if (who === null) return <Navigate to={signInPageUrl()} replace />
  if (who === 'unavailable') {
    return (
      <Page>
        <Unavailable message={SESSION_UNAVAILABLE} onRetry={retry} />
      </Page>
    )
  }
  return children(who)
}

// One function for the app's lifetime: the pages key their effects on it, so a
// default rebuilt per render would refetch on every render.
const sameOriginFetch: Fetch = (input, init) => globalThis.fetch(input, init)
const assignLocation: GoTo = (location) => window.location.assign(location)

export function ServerModeApp({
  fetchFn = sameOriginFetch,
  goTo = assignLocation,
}: Readonly<ServerModeAppProps>) {
  return (
    <Routes>
      <Route path={SIGN_IN_PAGE_PATH} element={<SignInPage fetchFn={fetchFn} goTo={goTo} />} />
      <Route path={INVITE_PAGE_PATH} element={<InvitePage fetchFn={fetchFn} goTo={goTo} />} />
      {/* Outside SignedInOnly: sending a signed-out popup to /sign-in would
          drop the fragment that carries the handshake, so the page says what
          to do instead. */}
      <Route
        path={RECEIVE_TRANSFER_PAGE_PATH}
        element={<ReceiveTransferPage fetchFn={fetchFn} />}
      />
      <Route
        path="/w/*"
        element={
          <SignedInOnly fetchFn={fetchFn}>
            {(user) => <OpenWorkspace fetchFn={fetchFn} displayName={user.displayName} />}
          </SignedInOnly>
        }
      />
      <Route
        path="/people"
        element={
          <SignedInOnly fetchFn={fetchFn}>
            {(user) => <TenantPeoplePage fetchFn={fetchFn} selfId={user.userId} />}
          </SignedInOnly>
        }
      />
      <Route
        path="/people/w/:workspace"
        element={
          <SignedInOnly fetchFn={fetchFn}>
            {() => <WorkspacePeoplePage fetchFn={fetchFn} />}
          </SignedInOnly>
        }
      />
      <Route path="*" element={<WorkspacesPage fetchFn={fetchFn} />} />
    </Routes>
  )
}
