/**
 * The web app as a server-mode keeper serves it (ADR-0047): same origin as
 * the keeper, so signing in is a navigation to its `/auth` routes and the
 * session is the host-only cookie the browser then holds.
 *
 * Sign in, accept an invitation, see the workspaces you are a member of, and
 * open one in the editor (`ServerModeWorkspace`), or sign out.
 */
import { listWorkspacesResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type SignInProvidersResponse,
  signInProvidersResponseSchema,
  signInRefusalSchema,
  signInSessionResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Button, buttonVariants } from '../components/ui/button.js'
import { workspacePath } from '../lib/app-routes.js'
import { GENERIC_SIGN_IN_REFUSAL, SIGN_IN_REFUSAL_COPY } from '../lib/sign-in-refusal-copy.js'
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
    void fetchFn('/auth/providers')
      .then(async (res) => (res.ok ? signInProvidersResponseSchema.parse(await res.json()) : null))
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
  return `/auth/sign-in/${encodeURIComponent(providerId)}?${query}`
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

interface Signed {
  displayName: string
  // 'unavailable': the session is real and the list failed — a person who is
  // signed in must not be sent to sign in again, or they loop.
  workspaces: { workspaceId: string; name: string }[] | 'unavailable'
}

async function loadSigned(fetchFn: Fetch): Promise<Signed | null> {
  const session = signInSessionResponseSchema.parse(await (await fetchFn('/auth/session')).json())
  if (!session.signedIn) return null
  const res = await fetchFn('/api/workspaces').catch(() => null)
  // An error answer fails the schema like any malformed one.
  const parsed = res && listWorkspacesResponseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed?.success) return { displayName: session.user.displayName, workspaces: 'unavailable' }
  return {
    displayName: session.user.displayName,
    workspaces: parsed.data.workspaces.map((w) => ({
      workspaceId: w.workspaceId,
      name: w.displayName ?? w.segment ?? w.workspaceId,
    })),
  }
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

function WorkspacesPage({ fetchFn }: { fetchFn: Fetch }) {
  const navigate = useNavigate()
  const [signed, setSigned] = useState<Signed | null | 'loading'>('loading')
  const [signOutFailed, setSignOutFailed] = useState(false)
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

  const signOut = async () => {
    const res = await fetchFn('/auth/sign-out', { method: 'POST' }).catch(() => null)
    if (res?.ok) navigate('/sign-in', { replace: true })
    else setSignOutFailed(true)
  }
  return (
    <Page>
      <header className="flex w-full max-w-md items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">Signed in as {signed.displayName}</span>
        <Button variant="outline" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
      {signOutFailed && (
        <p role="alert" className="text-sm text-destructive">
          Could not sign out. Try again.
        </p>
      )}
      <h1 className="text-xl font-semibold">Your workspaces</h1>
      <WorkspaceList workspaces={signed.workspaces} />
    </Page>
  )
}

// A workspace's routes answer 401 to a browser with no session; asking first
// sends it to the sign-in screen instead of an editor that cannot load.
function SignedInOnly({ fetchFn, children }: { fetchFn: Fetch; children: ReactNode }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void fetchFn('/auth/session')
      .then(async (res) => signInSessionResponseSchema.parse(await res.json()).signedIn)
      .catch(() => false)
      .then((value) => {
        if (live) setSignedIn(value)
      })
    return () => {
      live = false
    }
  }, [fetchFn])
  if (signedIn === null) return null
  return signedIn ? children : <Navigate to="/sign-in" replace />
}

// One function for the app's lifetime: the pages key their effects on it, so a
// default rebuilt per render would refetch on every render.
const sameOriginFetch: Fetch = (input, init) => globalThis.fetch(input, init)

export function ServerModeApp({ fetchFn = sameOriginFetch }: ServerModeAppProps) {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage fetchFn={fetchFn} />} />
      <Route path="/invite" element={<InvitePage fetchFn={fetchFn} />} />
      <Route
        path="/w/*"
        element={
          <SignedInOnly fetchFn={fetchFn}>
            <ServerModeWorkspace />
          </SignedInOnly>
        }
      />
      <Route path="*" element={<WorkspacesPage fetchFn={fetchFn} />} />
    </Routes>
  )
}
