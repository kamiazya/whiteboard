/**
 * The web app as a server-mode keeper serves it (ADR-0047): same origin as
 * the keeper, so signing in is a navigation to its `/auth` routes and the
 * session is the host-only cookie the browser then holds.
 *
 * Sign in, accept an invitation, see the workspaces you are a member of, make
 * one, and open one in the editor (`ServerModeWorkspace`), or sign out.
 */
import {
  authProvidersUrl,
  authSessionUrl,
  authSignInUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import {
  type SignInProvidersResponse,
  type SignInSessionResponse,
  signInProvidersResponseSchema,
  signInRefusalSchema,
  signInSessionResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { NewWorkspaceControl } from '../components/server-mode/NewWorkspaceControl.js'
import { ServerModeShell, SignOutControl } from '../components/server-mode/ServerModeShell.js'
import { buttonVariants } from '../components/ui/button.js'
import { useShellWorkspaces } from '../hooks/use-shell-workspaces.js'
import { type WorkspaceRoute, workspacePath, workspaceRoutePath } from '../lib/app-routes.js'
import { parseDaemonResponse } from '../lib/daemon-contract-error.js'
import { listMemberWorkspaces, type MemberWorkspace } from '../lib/member-workspaces.js'
import { GENERIC_SIGN_IN_REFUSAL, SIGN_IN_REFUSAL_COPY } from '../lib/sign-in-refusal-copy.js'
import { ReceiveTransferPage } from './ReceiveTransferPage.js'
import { TenantPeoplePage, WorkspacePeoplePage } from './ServerModePeoplePage.js'
import { ServerModeWorkspace } from './ServerModeWorkspace.js'

type Fetch = typeof globalThis.fetch

interface ServerModeAppProps {
  fetchFn?: Fetch
}

type Providers = SignInProvidersResponse['providers']

function useProviders(fetchFn: Fetch): Providers | null {
  const [providers, setProviders] = useState<Providers | null>(null)
  useEffect(() => {
    let live = true
    void fetchFn(authProvidersUrl())
      .then(async (res) =>
        res.ok
          ? parseDaemonResponse(authProvidersUrl(), signInProvidersResponseSchema, await res.json())
          : null,
      )
      .catch(() => null)
      .then((body) => {
        if (live) setProviders(body?.providers ?? [])
      })
    return () => {
      live = false
    }
  }, [fetchFn])
  return providers
}

function refusalMessage(search: string): string | null {
  const error = new URLSearchParams(search).get('error')
  if (error === null) return null
  const reason = signInRefusalSchema.safeParse(error)
  return reason.success ? SIGN_IN_REFUSAL_COPY[reason.data] : GENERIC_SIGN_IN_REFUSAL
}

function signInHref(providerId: string, invitation: string | undefined): string {
  const query = new URLSearchParams({ return: '/' })
  if (invitation !== undefined) query.set('invitation', invitation)
  return `${authSignInUrl(providerId)}?${query}`
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      {children}
    </main>
  )
}

function SignInPage({ fetchFn, invitation }: { fetchFn: Fetch; invitation?: string }) {
  const providers = useProviders(fetchFn)
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
      {providers !== null && providers.length === 0 && (
        <p className="max-w-md text-center text-sm text-muted-foreground">
          This server has no sign-in provider configured. Ask the person who runs it.
        </p>
      )}
      <ul className="flex w-full max-w-xs flex-col gap-2">
        {providers?.map((provider) => (
          <li key={provider.id}>
            <a
              href={signInHref(provider.id, invitation)}
              className={buttonVariants({ variant: 'outline', className: 'w-full' })}
            >
              Continue with {provider.displayName}
            </a>
          </li>
        ))}
      </ul>
    </Page>
  )
}

// The token rides the fragment, which the browser never sends to a server
// or puts in a Referer.
function InvitePage({ fetchFn }: { fetchFn: Fetch }) {
  const token = new URLSearchParams(useLocation().hash.slice(1)).get('token') ?? undefined
  return <SignInPage fetchFn={fetchFn} {...(token === undefined ? {} : { invitation: token })} />
}

type SessionUser = Extract<SignInSessionResponse, { signedIn: true }>['user']

interface Signed {
  user: SessionUser
  // 'unavailable': the session is real and the list failed — a person who is
  // signed in must not be sent to sign in again, or they loop.
  workspaces: MemberWorkspace[] | 'unavailable'
}

async function loadSigned(fetchFn: Fetch): Promise<Signed | null> {
  const session = parseDaemonResponse(
    authSessionUrl(),
    signInSessionResponseSchema,
    await (await fetchFn(authSessionUrl())).json(),
  )
  if (!session.signedIn) return null
  return { user: session.user, workspaces: await listMemberWorkspaces(fetchFn) }
}

function WorkspaceList({ workspaces }: { workspaces: Signed['workspaces'] }) {
  return workspaces === 'unavailable' ? (
    <p role="alert" className="text-sm text-destructive">
      Could not load your workspaces. Reload to try again.
    </p>
  ) : workspaces.length === 0 ? (
    <p className="text-sm text-muted-foreground">You are not a member of any workspace yet.</p>
  ) : (
    <ul className="flex w-full max-w-md flex-col gap-1">
      {workspaces.map((w) => (
        <li key={w.workspaceId}>
          <Link
            to={workspacePath(w.workspaceId)}
            className="block rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            {w.name}
          </Link>
        </li>
      ))}
    </ul>
  )
}

// The daemon shell's own workspace seam, pointed at this keeper's origin: the
// session cookie authenticates, so there is no token, and a create is the one
// call the switcher menu makes. Only the keeper's half is used here; the
// browser's is built beside it and never touched.
function useKeeperWorkspaces() {
  const navigate = useNavigate()
  const daemonShellTarget = useMemo(
    () => ({ baseUrl: window.location.origin, token: undefined }),
    [],
  )
  const setDaemonRoute = useCallback(
    (route: WorkspaceRoute) => navigate(workspaceRoutePath(route)),
    [navigate],
  )
  return useShellWorkspaces({ daemonShellTarget, navigate, setDaemonRoute }).daemonWorkspaces
}

// The shell is built under the workspace route, so the seam it renames through
// is made here rather than threaded down from the app.
function OpenWorkspace({
  fetchFn,
  displayName,
}: Readonly<{ fetchFn: Fetch; displayName: string }>) {
  const workspaces = useKeeperWorkspaces()
  return (
    <ServerModeWorkspace
      shell={
        <ServerModeShell displayName={displayName} fetchFn={fetchFn} workspaces={workspaces} />
      }
    />
  )
}

function WorkspacesPage({ fetchFn }: { fetchFn: Fetch }) {
  const keeperWorkspaces = useKeeperWorkspaces()
  const [signed, setSigned] = useState<Signed | null | 'loading'>('loading')
  useEffect(() => {
    let live = true
    void loadSigned(fetchFn)
      .catch(() => null)
      .then((result) => {
        if (live) setSigned(result)
      })
    return () => {
      live = false
    }
  }, [fetchFn])

  if (signed === 'loading') return null
  if (signed === null) return <Navigate to="/sign-in" replace />

  return (
    <Page>
      <header className="flex w-full max-w-md flex-wrap items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">
          Signed in as {signed.user.displayName}
        </span>
        {signed.user.administrator && (
          <Link to="/people" className="text-sm underline">
            People on this server
          </Link>
        )}
        <SignOutControl fetchFn={fetchFn} />
      </header>
      <h1 className="text-xl font-semibold">Your workspaces</h1>
      <WorkspaceList workspaces={signed.workspaces} />
      {keeperWorkspaces !== undefined && <NewWorkspaceControl workspaces={keeperWorkspaces} />}
    </Page>
  )
}

// A workspace's routes answer 401 to a browser with no session; asking first
// sends it to the sign-in screen instead of an editor that cannot load.
function SignedInOnly({
  fetchFn,
  children,
}: {
  fetchFn: Fetch
  children: (user: SessionUser) => ReactNode
}) {
  // undefined while asking, null for no session, the person otherwise.
  const [who, setWho] = useState<SessionUser | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void fetchFn(authSessionUrl())
      .then(async (res) => {
        const session = parseDaemonResponse(
          authSessionUrl(),
          signInSessionResponseSchema,
          await res.json(),
        )
        return session.signedIn ? session.user : null
      })
      .catch(() => null)
      .then((value) => {
        if (live) setWho(value)
      })
    return () => {
      live = false
    }
  }, [fetchFn])
  if (who === undefined) return null
  return who === null ? <Navigate to="/sign-in" replace /> : children(who)
}

// One function for the app's lifetime: the pages key their effects on it, so a
// default rebuilt per render would refetch on every render.
const sameOriginFetch: Fetch = (input, init) => globalThis.fetch(input, init)

export function ServerModeApp({ fetchFn = sameOriginFetch }: ServerModeAppProps) {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage fetchFn={fetchFn} />} />
      <Route path="/invite" element={<InvitePage fetchFn={fetchFn} />} />
      {/* Outside SignedInOnly: sending a signed-out popup to /sign-in would
          drop the fragment that carries the handshake, so the page says what
          to do instead. */}
      <Route path="/receive-transfer" element={<ReceiveTransferPage fetchFn={fetchFn} />} />
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
