import { readDaemonTokenOnce } from '@kamiazya/whiteboard-mcp/api-client'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BetaBanner } from './components/BetaBanner.js'
import { CanvasPageSkeleton } from './components/CanvasPageSkeleton.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { useDaemonConnection } from './hooks/useDaemonConnection.js'
import {
  consumeGrantFragment,
  type GrantConsumeResult,
  parseGrantFragment,
  renewPairingToken,
} from './lib/pairing-grant.js'

// Lazy: the /pair consent page transitively pulls daemon-api-client's zod
// schema chain, which must stay off the entry chunk's critical path (see
// apps/web/scripts/smoke-bundle-size.mjs). It renders on a rare, dedicated
// top-level navigation, so the extra chunk fetch is invisible.
const PairConsentPage = lazy(() =>
  import('./pages/PairConsentPage.js').then((m) => ({ default: m.PairConsentPage })),
)

import {
  browserLocalCanvasPath,
  type DaemonRoute,
  daemonRoutePath,
  parseBrowserLocalRoute,
  parseDaemonRoute,
} from './lib/app-routes.js'
import { IndexedDBStore } from './lib/browser-local-store.js'
import {
  BROWSER_LOCAL_CAPABILITIES,
  type ProviderState,
  resolveHostedProviderStateFromRaw,
} from './lib/provider.js'
import { createUserSettingsStore } from './lib/user-settings-store.js'

// Lazy so the daemon stack (DaemonBackend, ws-protocol, api client) stays out
// of the entry chunk — sessions arriving via a #wb= pairing fragment AND
// sessions with a runtime-config local-daemon provider state pay for it;
// pure browser-local sessions never import it, keeping that entry under the
// bundle-size budget.
const DaemonCanvasPage = lazy(() =>
  import('./pages/DaemonCanvasPage.js').then((m) => ({ default: m.DaemonCanvasPage })),
)

// Lazy for the same reason: BrowserLocalCanvasPage statically imports
// useCanvasSync (which imports loro-crdt), and it is the default render
// path (no daemon, no pairing fragment) — so it was the one making
// loro-crdt part of every session's initial paint even though
// DaemonCanvasPage above was already lazy.
const BrowserLocalCanvasPage = lazy(() =>
  import('./pages/BrowserLocalCanvasPage.js').then((m) => ({ default: m.BrowserLocalCanvasPage })),
)

// Lazy so the list stays outside the loro-crdt chunk the editor drags in.
const BrowserLocalIndexPage = lazy(() =>
  import('./pages/BrowserLocalIndexPage.js').then((m) => ({ default: m.BrowserLocalIndexPage })),
)

// Same lazy-chunk rationale as DaemonCanvasPage above — the gallery only
// matters once a daemon connection exists.
const DaemonIndexPage = lazy(() =>
  import('./pages/DaemonIndexPage.js').then((m) => ({ default: m.DaemonIndexPage })),
)

// Which daemon-mode view is showing: the canvas gallery, or a specific open
// canvas. A #wb= fragment with a slug skips straight to 'canvas'; local-daemon
// and slug-less pairing start on 'index'. `key` on the DaemonCanvasPage mount
// forces a clean remount (fresh controller/backend) on every index -> canvas
// transition instead of reusing a previous canvas's identity. Reuses
// DaemonRoute's shape (rather than a parallel type) since this state IS the
// route — app-routes.ts's parse/build functions keep the two in sync.
type DaemonView = DaemonRoute

interface AppProps {
  providerState?: ProviderState
}

// Suspense fallback shared by every lazy page chunk (DaemonCanvasPage and
// BrowserLocalCanvasPage). Reuses the structural CanvasPageSkeleton so the
// chunk-load state and the page's own connecting state are one continuous
// pulse instead of a text line snapping to a skeleton. The height class
// differs by mount site (root fills the viewport; the in-banner branches
// fill the flex row under it), so it's a prop; message becomes the
// accessible label so daemon-specific and backend-agnostic mount sites
// announce accurate copy.
export function LazyPageFallback({
  heightClass,
  message,
}: {
  heightClass: string
  message: string
}) {
  return (
    <div className={heightClass}>
      <CanvasPageSkeleton label={message} />
    </div>
  )
}

export function App({ providerState }: AppProps) {
  const [browserLocalStore] = useState(() => new IndexedDBStore())
  const [userSettingsStore] = useState(() => createUserSettingsStore())
  const [defaultProviderState] = useState<ProviderState>(() =>
    resolveHostedProviderStateFromRaw(
      (window as { __WHITEBOARD_RUNTIME_CONFIG__?: unknown }).__WHITEBOARD_RUNTIME_CONFIG__ ?? {},
      window.location.origin,
    ),
  )

  // Routed BEFORE providerState resolution: a #wb= pairing fragment always
  // wins over the runtime-config-driven provider state (which governs the
  // separate same-origin local-daemon / browser-local split). 'none' (no
  // fragment) falls through to that existing resolution unchanged.
  const daemonConnection = useDaemonConnection()
  const [forcedBrowserLocal, setForcedBrowserLocal] = useState(false)
  // Lazy initializer: readDaemonTokenOnce() consumes (deletes) the injected
  // global, so it must run exactly once per mount — calling it in the render
  // body would let StrictMode's double-render read-then-lose the token.
  const [daemonToken] = useState(() => readDaemonTokenOnce() ?? undefined)
  const location = useLocation()
  const navigate = useNavigate()

  // The daemon-served consent page is its OWN surface, not a daemon view:
  // parseDaemonRoute('/pair') is null, so without this guard the
  // daemonView -> URL sync effect below immediately navigated to '/',
  // dropping the origin/challenge/state query and dumping the user on the
  // gallery instead of the consent prompt.
  const isPairRoute = location.pathname === '/pair'

  // Pairing-grant return leg: a `#wb-grant=<code>&state=` fragment from the
  // daemon's /pair consent page. The exchange is async (a direct POST — the
  // token itself never rides the URL), so unlike the synchronous #wb= path
  // this resolves into state. The fragment is stripped IMMEDIATELY: the
  // code is single-use and 60s-lived, but it still must not linger in the
  // address bar or history.
  const [grantConnection, setGrantConnection] = useState<GrantConsumeResult | null>(() =>
    parseGrantFragment(window.location.hash) !== null ? { status: 'none' } : null,
  )
  const [grantErrorDismissed, setGrantErrorDismissed] = useState(false)
  useEffect(() => {
    const hash = window.location.hash
    if (parseGrantFragment(hash) === null) return
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    )
    void consumeGrantFragment({
      hash,
      sessionStorage: window.sessionStorage,
      fetch: globalThis.fetch.bind(globalThis),
    }).then(setGrantConnection)
    // Runs once per page load — the fragment only exists on a fresh
    // top-level navigation back from the consent page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Silent renewal: a later visit to a hosted origin that already holds a
  // pairing grant reconnects without any redirect — the browser-enforced
  // Origin header against the daemon's persisted grant is the whole
  // credential (POST /api/pairing/token, grantType 'origin'). Gated to the
  // no-fragment cold load: an in-flight #wb=/#wb-grant flow always wins,
  // and a 403/unreachable daemon collapses to 'none' so the app falls back
  // to browser-local exactly as before, with the banner as the path back.
  const attemptedRenewalRef = useRef(false)
  useEffect(() => {
    if (attemptedRenewalRef.current) return
    attemptedRenewalRef.current = true
    if (isPairRoute) return
    if (daemonConnection.status !== 'none') return
    if (grantConnection !== null) return
    if ((providerState ?? defaultProviderState).kind !== 'browser-local') return
    const storedBaseUrl = userSettingsStore.load().storage.localDaemonBaseUrl
    if (storedBaseUrl === undefined) return
    void renewPairingToken({
      daemonBaseUrl: storedBaseUrl,
      fetch: globalThis.fetch.bind(globalThis),
    }).then((result) => {
      // 'paired' connects; 'identity-mismatch' must ALSO land in state — it
      // is the fail-closed warning ("this daemon's identity changed"), and
      // dropping it here would silently swallow the whole verification.
      if (result.status === 'paired' || result.status === 'identity-mismatch') {
        setGrantConnection(result)
      }
    })
    // Cold-load decision over mount-time facts; the ref guards StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A #wb= fragment carrying both workspaceId+slug skips straight to the
  // canvas (the existing deep-link contract); a workspace-only fragment is
  // still a valid target (see daemon-connection-payload.ts's refine) and
  // starts on the gallery pre-scoped to that workspace rather than
  // whichever workspace the daemon happens to list first. Absent a fragment
  // (local-daemon's runtime-config path, or a same-origin cold load of a
  // `/canvas/:workspaceId/:slug` or `/w/:workspaceId` URL — e.g. a bookmark,
  // a shared link, or R3's "Open the local app" deep link), the URL itself
  // seeds the view. Lazy initializer: both the payload and the pathname at
  // mount time are fixed for the life of the mount.
  const [daemonView, setDaemonView] = useState<DaemonView>(() => {
    if (daemonConnection.status === 'paired') {
      const { workspaceId, slug } = daemonConnection.payload
      if (workspaceId && slug) return { kind: 'canvas', workspaceId, slug }
      return { kind: 'index', workspaceId }
    }
    return parseDaemonRoute(location.pathname) ?? { kind: 'index' }
  })

  // Derived per render, not read once at mount: '/' (no id) renders the
  // canvas list, /local/:canvasId mounts the editor. Once mounted, the
  // editor owns URL<->canvas-id sync for in-editor switching (it reads
  // initialCanvasId a single time), so App re-routes only when the URL
  // crosses the list/editor boundary — including browser Back from the
  // editor to the list.
  const browserLocalCanvasId = parseBrowserLocalRoute(location.pathname)?.canvasId

  // Keeps the address bar in sync with `daemonView` in both directions.
  //
  // State -> URL: fires whenever daemonView changes, whether from in-app
  // navigation (onOpenCanvas/onNavigateBack below) or from the #wb=
  // consume-once fragment establishing the initial view above. The very
  // first sync uses `replace` so the raw pairing URL never lingers as a
  // separate history entry the user could "back" into (it's already been
  // consumed and re-visiting it would silently do nothing); every
  // subsequent sync pushes, so browser back/forward has real steps to walk.
  const isFirstUrlSyncRef = useRef(true)
  useEffect(() => {
    if (isPairRoute) return
    // /local/:canvasId belongs to the browser-local world, not daemonView —
    // rewriting it to the daemon path would yank an open browser-local
    // editor back to the list.
    if (parseBrowserLocalRoute(location.pathname) !== null) return
    const path = daemonRoutePath(daemonView)
    // Read-then-clear on the FIRST EFFECT RUN regardless of whether it ends
    // up navigating: a no-op first run (URL already matches the initial
    // view) must not leave the very next real navigation still thinking
    // it's the first one and wrongly replacing instead of pushing.
    const isFirstSync = isFirstUrlSyncRef.current
    isFirstUrlSyncRef.current = false
    if (location.pathname === path) return
    navigate(path, { replace: isFirstSync })
    // location.pathname is read, not depended on: including it would refire
    // this effect on every navigation (including the one it just performed),
    // which is harmless but noisy. daemonView is the actual trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonView, navigate, isPairRoute])

  // URL -> state: handles the browser back/forward buttons (and, in
  // principle, any other code path that changes the route without going
  // through setDaemonView). Skips its own first run so it never overrides
  // the payload-preferring lazy initializer above with a stale pathname
  // that hasn't caught up to the #wb= sync effect yet.
  const isFirstRouteSyncRef = useRef(true)
  useEffect(() => {
    if (isPairRoute) return
    if (isFirstRouteSyncRef.current) {
      isFirstRouteSyncRef.current = false
      return
    }
    const parsed = parseDaemonRoute(location.pathname)
    if (parsed === null) return
    // parseDaemonRoute returns a fresh object every time, and React compares
    // state by reference — so re-set only when the route actually differs,
    // otherwise a back/forward landing on the current view re-renders for
    // nothing.
    setDaemonView((current) =>
      daemonRoutePath(current) === daemonRoutePath(parsed) ? current : parsed,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, isPairRoute])

  // Persists ONLY the reconnect target (baseUrl/workspaceId/slug), never the
  // bootstrapToken — the token stays in-memory via readDaemonTokenOnce's
  // existing semantics. This lets a later hosted-app load (a fresh tab with
  // no #wb= fragment) offer a one-click reconnect via DaemonDetectedBanner
  // instead of silently landing on browser-local with no path back.
  useEffect(() => {
    if (daemonConnection.status !== 'paired') return
    const { baseUrl, workspaceId, slug } = daemonConnection.payload
    // update() serializes and writes to localStorage synchronously; skip it
    // when the stored target already matches what we would write.
    const stored = userSettingsStore.load().storage
    if (
      stored.localDaemonBaseUrl === baseUrl &&
      stored.lastConnectedWorkspaceId === workspaceId &&
      stored.lastConnectedSlug === slug
    ) {
      return
    }
    userSettingsStore.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        localDaemonBaseUrl: baseUrl,
        lastConnectedWorkspaceId: workspaceId,
        lastConnectedSlug: slug,
      },
    }))
    // daemonConnection is a stable module-scope singleton for the life of the
    // tab (see useDaemonConnection.ts) — this effect is meant to run once per
    // successful pairing, not on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonConnection.status])

  useEffect(() => {
    if (grantConnection?.status !== 'paired') return
    userSettingsStore.update((current) => ({
      ...current,
      storage: { ...current.storage, localDaemonBaseUrl: grantConnection.daemonBaseUrl },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantConnection?.status])

  // The daemon-served /pair consent page (pairing-grant flow) — rendered
  // in place of every other view; approving needs the R3-injected token.
  if (isPairRoute) {
    return (
      <Suspense fallback={<LazyPageFallback heightClass="h-dvh" message="Loading…" />}>
        <PairConsentPage daemonToken={daemonToken} />
      </Suspense>
    )
  }

  // The 'Continue in browser-local' escape hatch opts out of the pairing
  // fragment entirely, so once it's set both daemon branches are skipped.
  if (!forcedBrowserLocal) {
    // Both pairing paths converge here: the legacy #wb= fragment carries
    // its token inline; the grant flow resolved its token via the POST
    // exchange above. Either way the daemon pages just get baseUrl+token.
    const grantPaired = grantConnection?.status === 'paired' ? grantConnection : null
    if (daemonConnection.status === 'paired' || grantPaired !== null) {
      const payload =
        daemonConnection.status === 'paired'
          ? daemonConnection.payload
          : {
              baseUrl: (grantPaired as { daemonBaseUrl: string }).daemonBaseUrl,
              workspaceId: undefined,
              slug: undefined,
            }
      const pairedToken =
        daemonConnection.status === 'paired'
          ? daemonConnection.payload.authMode === 'bootstrap'
            ? daemonConnection.payload.bootstrapToken
            : undefined
          : (grantPaired as { token: string }).token
      return (
        // ErrorBoundary sits outside Suspense: a lazy-chunk load failure
        // propagates through Suspense's own error path to the nearest
        // boundary, which must be here to catch it.
        <ErrorBoundary>
          {/* Pages size to their allotted height (h-full) so app-level rows
              like the beta banner can never clip them — this bannerless
              branch supplies the viewport height itself. */}
          <div className="h-dvh">
            <Suspense
              fallback={<LazyPageFallback heightClass="h-dvh" message="Connecting to daemon…" />}
            >
              {daemonView.kind === 'index' ? (
                <DaemonIndexPage
                  daemonBaseUrl={payload.baseUrl}
                  token={pairedToken}
                  initialWorkspaceId={daemonView.workspaceId}
                  onOpenCanvas={(workspaceId, slug) =>
                    setDaemonView({ kind: 'canvas', workspaceId, slug })
                  }
                />
              ) : (
                <DaemonCanvasPage
                  key={`${daemonView.workspaceId}:${daemonView.slug}`}
                  daemonBaseUrl={payload.baseUrl}
                  workspaceId={daemonView.workspaceId}
                  slug={daemonView.slug}
                  token={pairedToken}
                  onContinueBrowserLocal={() => setForcedBrowserLocal(true)}
                  browserLocalStore={browserLocalStore}
                  onNavigateBack={() =>
                    setDaemonView({ kind: 'index', workspaceId: daemonView.workspaceId })
                  }
                />
              )}
            </Suspense>
          </div>
        </ErrorBoundary>
      )
    }

    if (daemonConnection.status === 'error') {
      return (
        <ErrorBoundary>
          <div
            role="alert"
            aria-live="assertive"
            className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center"
          >
            <p className="max-w-md text-sm text-destructive">
              The daemon pairing link could not be used. You can continue without a daemon
              connection.
            </p>
            <button
              type="button"
              onClick={() => setForcedBrowserLocal(true)}
              className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
            >
              Continue in browser-local
            </button>
          </div>
        </ErrorBoundary>
      )
    }
  }

  const state = providerState ?? defaultProviderState

  // The 'Continue in browser-local' escape hatch collapses a local-daemon OR
  // invalid-config state to browser-local capabilities, so every downstream
  // consumer (chip, banner, canvas page) reads this effective state rather
  // than the raw one — otherwise the escape could leave daemon capabilities
  // or copy leaking into a mode the user explicitly opted out of, or bounce
  // a failed-pairing escape onto the invalid-config error page.
  const effectiveState =
    forcedBrowserLocal && (state.kind === 'local-daemon' || state.kind === 'invalid-config')
      ? { kind: 'browser-local' as const, capabilities: BROWSER_LOCAL_CAPABILITIES }
      : state

  if (effectiveState.kind === 'invalid-config') {
    return (
      <ErrorBoundary>
        <main data-provider="invalid-config">
          <p>{effectiveState.message}</p>
        </main>
      </ErrorBoundary>
    )
  }

  if (effectiveState.kind === 'local-daemon') {
    return (
      <ErrorBoundary>
        <div className="flex h-dvh flex-col">
          <BetaBanner
            store={userSettingsStore}
            message="Beta preview — features may be incomplete."
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense
              fallback={<LazyPageFallback heightClass="h-full" message="Connecting to daemon…" />}
            >
              {daemonView.kind === 'index' ? (
                <DaemonIndexPage
                  daemonBaseUrl={effectiveState.daemonBaseUrl}
                  token={daemonToken}
                  initialWorkspaceId={daemonView.workspaceId}
                  onOpenCanvas={(workspaceId, slug) =>
                    setDaemonView({ kind: 'canvas', workspaceId, slug })
                  }
                />
              ) : (
                <DaemonCanvasPage
                  key={`${daemonView.workspaceId}:${daemonView.slug}`}
                  daemonBaseUrl={effectiveState.daemonBaseUrl}
                  workspaceId={daemonView.workspaceId}
                  slug={daemonView.slug}
                  capabilities={effectiveState.capabilities}
                  token={daemonToken}
                  browserLocalStore={browserLocalStore}
                  onContinueBrowserLocal={() => setForcedBrowserLocal(true)}
                  onNavigateBack={() =>
                    setDaemonView({ kind: 'index', workspaceId: daemonView.workspaceId })
                  }
                />
              )}
            </Suspense>
          </div>
        </div>
      </ErrorBoundary>
    )
  }

  // Own the viewport as a flex column so the in-flow banner sits ABOVE the
  // canvas. Pages size to the height this shell allots them (h-full), so
  // the banner displaces the canvas instead of clipping its bottom edge —
  // the tool palette used to vanish behind the viewport on phones exactly
  // because the page claimed h-dvh underneath an in-flow banner.
  return (
    <ErrorBoundary>
      <div className="flex h-dvh flex-col">
        <BetaBanner
          store={userSettingsStore}
          message="Beta preview — your data is stored only in this browser."
        />
        {grantConnection?.status === 'identity-mismatch' && !grantErrorDismissed && (
          // Fail-closed renewal refusal: a PINNED daemon answered with a
          // wrong or missing identity signature. Either the daemon rotated
          // its key (delete + regenerate) or something else is on its port —
          // both need a fresh human approval on the daemon's consent page.
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-2 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
          >
            <span>
              This daemon's identity changed — automatic reconnection was refused. If you rotated or
              reinstalled the daemon, re-approve it from "Check for local daemon"; otherwise treat
              this as a warning that something else may be answering on its port.
            </span>
            <button
              type="button"
              onClick={() => setGrantErrorDismissed(true)}
              aria-label="Dismiss identity warning"
              className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
            >
              Dismiss
            </button>
          </div>
        )}
        {grantConnection?.status === 'error' && !grantErrorDismissed && (
          // The user just clicked Approve on the daemon's consent page —
          // landing back here on browser-local with no explanation was a
          // silent dead end. The likeliest cause on a hosted origin is the
          // browser's local-network permission still being closed.
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-2 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
          >
            <span>
              Pairing didn't complete: {grantConnection.detail}. If your browser asked for
              permission to reach local devices, allow it and try again from "Check for local
              daemon".
            </span>
            <button
              type="button"
              onClick={() => setGrantErrorDismissed(true)}
              aria-label="Dismiss pairing error"
              className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
            >
              Dismiss
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<LazyPageFallback heightClass="h-full" message="Loading…" />}>
            {browserLocalCanvasId === undefined ? (
              // '/' (and any non-/local path) lands on the canvas list. The
              // editor mounts only for /local/:canvasId, whose in-editor
              // canvas switching it keeps owning — App re-routes solely when
              // the URL crosses the list/editor boundary.
              <BrowserLocalIndexPage
                store={browserLocalStore}
                onOpenCanvas={(id) => navigate(browserLocalCanvasPath(id))}
              />
            ) : (
              <BrowserLocalCanvasPage
                store={browserLocalStore}
                capabilities={effectiveState.capabilities}
                initialCanvasId={browserLocalCanvasId}
              />
            )}
          </Suspense>
        </div>
      </div>
    </ErrorBoundary>
  )
}
