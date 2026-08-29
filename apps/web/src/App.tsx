import { readDaemonTokenOnce } from '@kamiazya/whiteboard-mcp/api-client'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { AppShellWorkspaces } from './components/AppShell.js'
import { AppShellLazy } from './components/AppShellLazy.js'

// Lazy: the not-found page renders on rare, dead-end navigations only —
// it must not ride the critical-path bundle.
const NotFoundPage = lazy(() =>
  import('./components/status/NotFoundPage.js').then((m) => ({ default: m.NotFoundPage })),
)

import { DocumentPageSkeleton } from './components/DocumentPageSkeleton.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { useDaemonConnection } from './hooks/useDaemonConnection.js'
import {
  browserWorkspaceIdentitySnapshot,
  browserWorkspaceMatches,
  subscribeBrowserWorkspaceIdentity,
  switchBrowserWorkspace,
} from './lib/browser-workspace-id.js'
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

// Lazy for the same reason as the other secondary surfaces above: /settings
// is a rare, dedicated navigation (not part of the canvas critical path).
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
)

import {
  documentPath,
  isKnownAppPath,
  parseSettingsRoute,
  parseWorkspaceRoute,
  type WorkspaceRoute,
  workspacePath,
  workspaceRoutePath,
} from './lib/app-routes.js'
import {
  BROWSER_CAPABILITIES,
  type ProviderState,
  resolveHostedProviderStateFromRaw,
} from './lib/provider.js'
import { createUserSettingsStore } from './lib/user-settings-store.js'
import { workspaceHandle } from './lib/workspace-handle.js'

// Lazy so the daemon stack (DaemonBackend, ws-protocol, api client) stays out
// of the entry chunk — sessions arriving via a #wb= pairing fragment AND
// sessions with a runtime-config daemon provider state pay for it;
// pure browser sessions never import it, keeping that entry under the
// bundle-size budget.
const DaemonDocumentPage = lazy(() =>
  import('./pages/DaemonDocumentPage.js').then((m) => ({ default: m.DaemonDocumentPage })),
)

// Lazy for the same reason: BrowserDocumentPage statically imports
// useDocumentSync (which imports loro-crdt), and it is the default render
// path (no daemon, no pairing fragment) — so it was the one making
// loro-crdt part of every session's initial paint even though
// DaemonDocumentPage above was already lazy.
const BrowserDocumentPage = lazy(() =>
  import('./pages/BrowserDocumentPage.js').then((m) => ({
    default: m.BrowserDocumentPage,
  })),
)

// Lazy so the list stays outside the loro-crdt chunk the editor drags in.
const BrowserIndexPage = lazy(() =>
  import('./pages/BrowserIndexPage.js').then((m) => ({ default: m.BrowserIndexPage })),
)

// Same lazy-chunk rationale as DaemonDocumentPage above — the gallery only
// matters once a daemon connection exists.
const DaemonIndexPage = lazy(() =>
  import('./pages/DaemonIndexPage.js').then((m) => ({ default: m.DaemonIndexPage })),
)

// Which daemon-mode view is showing: the canvas gallery, or a specific open
// canvas. A #wb= fragment with a path skips straight to 'canvas'; a daemon
// and path-less pairing start on 'index'. `key` on the DaemonDocumentPage mount
// forces a clean remount (fresh controller/backend) on every index -> canvas
// transition instead of reusing a previous canvas's identity. Reuses
// DaemonRoute's shape (rather than a parallel type) since this state IS the
// route — app-routes.ts's parse/build functions keep the two in sync.
type DaemonView = WorkspaceRoute

interface AppProps {
  providerState?: ProviderState
}

// Suspense fallback shared by every lazy page chunk (DaemonDocumentPage and
// BrowserDocumentPage). Reuses the structural DocumentPageSkeleton so the
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
      <DocumentPageSkeleton label={message} />
    </div>
  )
}

export function App({ providerState }: AppProps) {
  // The browser's DocumentIndex (the workspace tree behind the startup fold)
  // is NOT constructed here: the pages that need it default to the shared
  // instance from folding-browser-index.ts, which keeps loro-crdt off the
  // entry chunk's critical path (entry-graph-loro-free.test.ts).
  const [userSettingsStore] = useState(() => createUserSettingsStore())
  const [defaultProviderState] = useState<ProviderState>(() =>
    resolveHostedProviderStateFromRaw(
      (window as { __WHITEBOARD_RUNTIME_CONFIG__?: unknown }).__WHITEBOARD_RUNTIME_CONFIG__ ?? {},
      window.location.origin,
    ),
  )

  // Routed BEFORE providerState resolution: a #wb= pairing fragment always
  // wins over the runtime-config-driven provider state (which governs the
  // separate same-origin daemon / browser split). 'none' (no
  // fragment) falls through to that existing resolution unchanged.
  const daemonConnection = useDaemonConnection()
  const [forcedBrowser, setForcedBrowser] = useState(false)
  // Lazy initializer: readDaemonTokenOnce() consumes (deletes) the injected
  // global, so it must run exactly once per mount — calling it in the render
  // body would let StrictMode's double-render read-then-lose the token.
  const [daemonToken] = useState(() => readDaemonTokenOnce() ?? undefined)
  const location = useLocation()
  const navigate = useNavigate()

  // The daemon-served consent page is its OWN surface, not a daemon view:
  // parseWorkspaceRoute('/pair') is null, so without this guard the
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
  // to the browser exactly as before, with the banner as the path back.
  const attemptedRenewalRef = useRef(false)
  useEffect(() => {
    if (attemptedRenewalRef.current) return
    attemptedRenewalRef.current = true
    if (isPairRoute) return
    if (daemonConnection.status !== 'none') return
    if (grantConnection !== null) return
    if ((providerState ?? defaultProviderState).kind !== 'browser') return
    const storedBaseUrl = userSettingsStore.load().storage.daemonBaseUrl
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

  // A #wb= fragment carrying both workspaceId+path skips straight to the
  // canvas (the existing deep-link contract); a workspace-only fragment is
  // still a valid target (see daemon-connection-payload.ts's refine) and
  // starts on the gallery pre-scoped to that workspace rather than
  // whichever workspace the daemon happens to list first. Absent a fragment
  // (the daemon's runtime-config path, or a same-origin cold load of a
  // `/w/:workspaceId/d/:path` or `/w/:workspaceId` URL — e.g. a bookmark,
  // a shared link, or R3's "Open the local app" deep link), the URL itself
  // seeds the view. Lazy initializer: both the payload and the pathname at
  // mount time are fixed for the life of the mount.
  const [daemonView, setDaemonView] = useState<DaemonView>(() => {
    if (daemonConnection.status === 'paired') {
      const { workspaceId, path } = daemonConnection.payload
      if (workspaceId && path) return { kind: 'document', workspace: workspaceId, path }
      return { kind: 'index', workspace: workspaceId }
    }
    return parseWorkspaceRoute(location.pathname) ?? { kind: 'index' }
  })

  // Derived per render, not read once at mount: an index route renders the
  // document list, a document route mounts the editor. Once mounted, the
  // editor owns URL<->document sync for in-editor switching (it reads
  // initialPath a single time), so App re-routes only when the URL crosses
  // the list/editor boundary — including browser Back from the editor to the
  // list.
  // SUBSCRIBED, not merely read. `boot.ts` bounds the identity resolve at 3s
  // and renders degraded past it, so the identity can settle while React is
  // already mounted — a stale tab blocking the IndexedDB version upgrade
  // reaches that path for real. Read without a subscription, the module
  // updates and nothing re-renders: a valid document deep link stays on the
  // index, and the null handle below disables every navigation out of it, for
  // the life of the tab.
  //
  // Null while the identity has not resolved (or failed to). A URL builder
  // that cannot name its workspace declines to navigate rather than sending
  // the session somewhere wrong.
  const browserIdentity = useSyncExternalStore(
    subscribeBrowserWorkspaceIdentity,
    browserWorkspaceIdentitySnapshot,
  )
  const browserHandle = browserIdentity === null ? null : workspaceHandle(browserIdentity)
  const browserRoute = parseWorkspaceRoute(location.pathname)
  // Only a route naming THIS browser's workspace opens a document here. One
  // grammar means a daemon address parses under the browser keeper too, and
  // it names a workspace this keeper does not have — reachable by hand, and
  // reached for real by the 'Work in this browser instead' escape, which
  // leaves a `/w/<daemon-ws>/d/...` address behind as it switches
  // keeper. Treating that as a browser document would open a path in a
  // workspace that does not exist here; the index is the honest answer, and
  // is what this shell already showed while the two grammars kept them apart.
  //
  // Matched against BOTH layers, not against the handle: the canonical-id
  // form is the durable link, and comparing to `segment ?? id` rejects it the
  // moment a segment exists.
  const browserPath =
    browserRoute?.kind === 'document' && browserWorkspaceMatches(browserRoute.workspace)
      ? browserRoute.path
      : undefined

  // Keeps the address bar in sync with `daemonView` in both directions.
  //
  // State -> URL: fires whenever daemonView changes, whether from in-app
  // navigation (onOpenDocument/onNavigateBack below) or from the #wb=
  // consume-once fragment establishing the initial view above. The very
  // first sync uses `replace` so the raw pairing URL never lingers as a
  // separate history entry the user could "back" into (it's already been
  // consumed and re-visiting it would silently do nothing); every
  // subsequent sync pushes, so browser back/forward has real steps to walk.
  const state = providerState ?? defaultProviderState

  // The 'Work in this browser instead' escape hatch collapses a daemon OR
  // invalid-config state to browser capabilities, so every downstream
  // consumer (chip, banner, canvas page) reads this effective state rather
  // than the raw one — otherwise the escape could leave daemon capabilities
  // or copy leaking into a mode the user explicitly opted out of, or bounce
  // a failed-pairing escape onto the invalid-config error page.
  const effectiveState =
    forcedBrowser && (state.kind === 'daemon' || state.kind === 'invalid-config')
      ? { kind: 'browser' as const, capabilities: BROWSER_CAPABILITIES }
      : state

  // WHO KEEPS this session's workspace, stated once.
  //
  // It is decided by pairing and provider state — ADR-0004 settles it at page
  // load — and the two branches below are the same two conditions the render
  // tail uses to choose a daemon tree over the browser one. Derived here
  // rather than there because the URL-sync effects need it: hooks cannot be
  // conditional, so they run under BOTH keepers and something has to tell
  // them which one this is.
  //
  // That used to be the URL's own shape (`parseBrowserRoute(...) !== null`),
  // which worked only because `/local/*` named the keeper in the address.
  // Reading the keeper off the address is exactly what three-layer identity
  // exists to stop, and the guard could not survive the two route families
  // becoming one.
  const daemonKept =
    (!forcedBrowser &&
      (daemonConnection.status === 'paired' || grantConnection?.status === 'paired')) ||
    effectiveState.kind === 'daemon'

  const isFirstUrlSyncRef = useRef(true)
  // The path this effect last navigated to. StrictMode's effect replay
  // re-runs the effect with the PRE-navigation location still in its
  // closure, so without this the replay pushes a duplicate history entry
  // for the navigation the first run already performed.
  const lastNavigatedPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (isPairRoute) return
    // A browser-kept session's address is not daemonView's to write —
    // rewriting it would yank an open browser-kept editor back to the list.
    if (!daemonKept) return
    // /settings is its own top-level surface, not a daemonView — without
    // this the sync effect below would immediately rewrite it to '/'.
    if (parseSettingsRoute(location.pathname) !== null) return
    // An unknown path is the not-found page's to keep: rewriting it to the
    // daemon route would swallow the 404 into a silent redirect.
    if (!isKnownAppPath(location.pathname)) return
    const path = workspaceRoutePath(daemonView)
    // Read-then-clear on the FIRST EFFECT RUN regardless of whether it ends
    // up navigating: a no-op first run (URL already matches the initial
    // view) must not leave the very next real navigation still thinking
    // it's the first one and wrongly replacing instead of pushing.
    const isFirstSync = isFirstUrlSyncRef.current
    isFirstUrlSyncRef.current = false
    if (location.pathname === path) {
      lastNavigatedPathRef.current = null
      return
    }
    if (lastNavigatedPathRef.current === path) return
    lastNavigatedPathRef.current = path
    // Naming an address that named nothing is a REPLACE. `/` does not say
    // which workspace is on screen; the page resolves one and this writes it
    // down, which is the app finishing a sentence rather than a step the
    // person took. Pushed, it would put `/` behind them — and going back
    // there resolves again and pushes again, a trap of our own making.
    // Changing a workspace the address already named is a real step and
    // pushes, so back returns to the one before.
    //
    // Narrow to index -> index deliberately. Opening a DOCUMENT from `/` also
    // leaves an address that named no workspace, and it is a step: replacing
    // there costs the back button the list you came from.
    const currentRoute = parseWorkspaceRoute(location.pathname)
    const namingTheSameIndex =
      daemonView.kind === 'index' &&
      currentRoute?.kind === 'index' &&
      currentRoute.workspace === undefined
    navigate(path, { replace: isFirstSync || namingTheSameIndex })
    // location.pathname is read, not depended on: including it would refire
    // this effect on every navigation (including the one it just performed),
    // which is harmless but noisy. daemonView is the actual trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonView, navigate, isPairRoute, daemonKept])

  // Which daemon the SHELL is talking to, resolved once from the same three
  // sources the render branches below each resolve for themselves: a #wb=
  // pairing payload, a completed grant exchange, or the configured provider
  // state. Hoisted above the branches because a hook cannot live inside one,
  // and the switcher has to work on the pairing-link path too — that branch
  // renders the same index page, so leaving it out would have taken the
  // deleted select away with nothing in its place.
  const grantPaired = grantConnection?.status === 'paired' ? grantConnection : null
  const shellDaemonBaseUrl =
    daemonConnection.status === 'paired'
      ? daemonConnection.payload.baseUrl
      : grantPaired !== null
        ? grantPaired.daemonBaseUrl
        : effectiveState.kind === 'daemon'
          ? effectiveState.daemonBaseUrl
          : undefined
  const shellDaemonToken =
    daemonConnection.status === 'paired'
      ? daemonConnection.payload.authMode === 'bootstrap'
        ? daemonConnection.payload.bootstrapToken
        : undefined
      : grantPaired !== null
        ? grantPaired.token
        : (daemonToken ?? undefined)
  // Memoised on the two SCALARS rather than on the connection objects: those
  // are rebuilt per render, and the switcher reads its list in an effect keyed
  // on this source — a fresh object each render is a fetch each render.
  const daemonShellTarget = useMemo(
    () =>
      forcedBrowser || shellDaemonBaseUrl === undefined
        ? undefined
        : { baseUrl: shellDaemonBaseUrl, token: shellDaemonToken },
    [forcedBrowser, shellDaemonBaseUrl, shellDaemonToken],
  )

  // The daemon keeper's switcher source, built from whichever daemon this
  // branch is talking to. Dynamic import for the same reason the browser's
  // is: the shell is lazy, App is not.
  //
  // No `create`: the daemon publishes `GET /api/workspaces` and nothing that
  // writes one, so the switcher offers no creation there. DESIGN.md's
  // standing rule — never offer what the keeper cannot honour — and absent
  // rather than disabled, because a disabled control says "not right now"
  // about something that is not there at all.
  //
  // Switching is an in-app navigation, unlike the browser's: this keeper has
  // no synchronous singleton to re-point, so setting the view is enough. The
  // address follows from it, and the index page follows the address.
  const daemonWorkspaces = useMemo(
    (): AppShellWorkspaces | undefined =>
      daemonShellTarget === undefined
        ? undefined
        : {
            source: {
              list: () =>
                import('./lib/daemon-api-client.js').then((m) =>
                  m
                    .listWorkspaces(
                      m.createDaemonFetch(daemonShellTarget.baseUrl, daemonShellTarget.token),
                      daemonShellTarget.baseUrl,
                    )
                    .then((res) => res.workspaces),
                ),
            },
            onSwitch: (workspace: string) => setDaemonView({ kind: 'index', workspace }),
          },
    [daemonShellTarget],
  )

  // The browser keeper's switcher source. Both halves reach their module
  // through a dynamic import so the workspace registry — and the create path
  // behind it — stay off the critical path; the shell is lazy, but App is
  // not, and a static import here would put IndexedDB index code in the
  // entry chunk for a control most sessions never open.
  //
  // A switch is a document LOAD, not an in-app navigation. This keeper
  // resolves its active workspace once, into a synchronous accessor whose
  // whole rationale is that some twenty call sites read it inline; re-pointing
  // it in place would mean re-reading it at every one of them. A load also
  // settles the outgoing workspace's writes for free, which is the invariant
  // a switch has to keep.
  const browserWorkspaces = useMemo(
    () => ({
      source: {
        list: () => import('./lib/browser-workspaces.js').then((m) => m.listBrowserWorkspaces()),
        create: (displayName: string) =>
          import('./lib/browser-workspaces.js').then((m) =>
            m.createBrowserWorkspaceNamed(displayName),
          ),
        rename: (workspaceId: string, input: { segment?: string; displayName?: string }) =>
          import('./lib/browser-workspaces.js').then((m) =>
            m.renameBrowserWorkspace(workspaceId, input),
          ),
      },
      // An in-SPA route change (ADR-0019), not a document load. The address
      // moves first and the identity follows it, which is the same direction
      // everything else in this app reads: the effect below re-points the
      // active workspace to whatever the address names, and rewrites the
      // address only when it names nothing this browser holds.
      onSwitch: (handle: string) => {
        navigate(workspacePath(handle))
      },
    }),
    [navigate],
  )

  // The browser keeper's half of the same rule, and it exists for the same
  // reason the daemon's does: the address has to NAME the workspace on
  // screen. It went unwritten while this keeper held exactly one workspace,
  // where `/` and `/w/default` were the same statement in practice. They are
  // not once a workspace can be switched — the switcher changes the outermost
  // address layer, and `/` has no layer to change — and they were never the
  // same to `boot.ts`, which resolves the active workspace from
  // `parseWorkspaceRoute(location.pathname)?.workspace`: at `/` that is
  // always undefined, so a reload took first-listed no matter where the
  // person was.
  //
  // Two addresses get rewritten, and the second is not hypothetical. "Work in
  // this browser instead" switches keeper under a `/w/<daemon-workspace>/...`
  // address; the page already falls back to the index for it, but the address
  // kept naming a workspace this browser does not keep.
  //
  // REPLACE, like the daemon's: the app is finishing a sentence the person
  // started. Pushed, back would return to an address that rewrites itself
  // again — a trap of our own making.
  useEffect(() => {
    if (isPairRoute) return
    if (daemonKept) return
    if (browserHandle === null) return
    if (parseSettingsRoute(location.pathname) !== null) return
    if (!isKnownAppPath(location.pathname)) return
    const route = parseWorkspaceRoute(location.pathname)
    const named = route === null ? undefined : route.workspace
    if (named !== undefined && browserWorkspaceMatches(named)) return
    let cancelled = false
    const rewrite = () => {
      if (cancelled) return
      const path = workspacePath(browserHandle)
      if (location.pathname !== path) navigate(path, { replace: true })
    }
    // An address naming a workspace this browser DOES hold is a switch, not a
    // mistake — the switcher moves the address and this is what makes the
    // runtime follow. Only a handle the registry cannot resolve gets the
    // address rewritten, and `switchBrowserWorkspace` is strict precisely so
    // the two cases stay distinguishable here: a lenient resolve would answer
    // every unknown handle with first-listed, and this effect would then
    // rewrite the address to a workspace nobody asked for while believing it
    // had switched.
    if (named === undefined) {
      rewrite()
    } else {
      switchBrowserWorkspace(named).then((moved) => {
        if (moved === null) rewrite()
      }, rewrite)
    }
    return () => {
      cancelled = true
    }
  }, [location.pathname, browserHandle, daemonKept, isPairRoute, navigate])

  // URL -> state: handles the browser back/forward buttons (and, in
  // principle, any other code path that changes the route without going
  // through setDaemonView).
  // Guarded by pathname VALUE, not a first-run flag: StrictMode's effect
  // replay re-runs this effect with the pre-navigation pathname still in
  // its closure, and a run-count flag let that replay read the stale '/'
  // as user intent — overwriting the #wb= payload-derived canvas view with
  // the gallery and, in a live browser, seeding a perpetual navigation
  // ping-pong that remounted the canvas page (and its WebSocket) ~170
  // times a second. Only an actual pathname CHANGE is a URL-driven
  // navigation; the ref seeds from the mount pathname so the mount run and
  // any replay of it are no-ops.
  const lastRouteSyncPathRef = useRef(location.pathname)
  useEffect(() => {
    if (isPairRoute) return
    if (lastRouteSyncPathRef.current === location.pathname) return
    lastRouteSyncPathRef.current = location.pathname
    const parsed = parseWorkspaceRoute(location.pathname)
    if (parsed === null) return
    // parseDaemonRoute returns a fresh object every time, and React compares
    // state by reference — so re-set only when the route actually differs,
    // otherwise a back/forward landing on the current view re-renders for
    // nothing.
    setDaemonView((current) =>
      workspaceRoutePath(current) === workspaceRoutePath(parsed) ? current : parsed,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, isPairRoute])

  // Persists ONLY the reconnect target (baseUrl/workspaceId/path), never the
  // bootstrapToken — the token stays in-memory via readDaemonTokenOnce's
  // existing semantics. This lets a later hosted-app load (a fresh tab with
  // no #wb= fragment) offer a one-click reconnect via DaemonDetectedBanner
  // instead of silently landing on the browser with no path back.
  useEffect(() => {
    if (daemonConnection.status !== 'paired') return
    const { baseUrl, workspaceId, path } = daemonConnection.payload
    // update() serializes and writes to localStorage synchronously; skip it
    // when the stored target already matches what we would write.
    const stored = userSettingsStore.load().storage
    if (
      stored.daemonBaseUrl === baseUrl &&
      stored.lastConnectedWorkspaceId === workspaceId &&
      stored.lastConnectedPath === path
    ) {
      return
    }
    userSettingsStore.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        daemonBaseUrl: baseUrl,
        lastConnectedWorkspaceId: workspaceId,
        lastConnectedPath: path,
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
      storage: { ...current.storage, daemonBaseUrl: grantConnection.daemonBaseUrl },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantConnection?.status])

  // /settings renders on its own route ahead of (and independent from) the
  // daemon/browser branch below, so its daemon connection needs
  // resolving here rather than reusing a `payload`/`effectiveState` local
  // that only exists inside one of those branches' own scope.
  const grantPairedForSettings = grantConnection?.status === 'paired' ? grantConnection : null
  const providerStateForSettings = providerState ?? defaultProviderState
  const settingsDaemon: { baseUrl: string; token: string | null } | undefined = forcedBrowser
    ? undefined
    : daemonConnection.status === 'paired'
      ? {
          baseUrl: daemonConnection.payload.baseUrl,
          token:
            daemonConnection.payload.authMode === 'bootstrap'
              ? (daemonConnection.payload.bootstrapToken ?? null)
              : null,
        }
      : grantPairedForSettings !== null
        ? { baseUrl: grantPairedForSettings.daemonBaseUrl, token: grantPairedForSettings.token }
        : providerStateForSettings.kind === 'daemon'
          ? { baseUrl: providerStateForSettings.daemonBaseUrl, token: daemonToken ?? null }
          : undefined

  // The daemon-served /pair consent page (pairing-grant flow) — rendered
  // in place of every other view; approving needs the R3-injected token.
  if (isPairRoute) {
    return (
      <Suspense fallback={<LazyPageFallback heightClass="h-dvh" message="Loading…" />}>
        <PairConsentPage daemonToken={daemonToken} />
      </Suspense>
    )
  }

  // Outside the closed route set: say so instead of silently falling
  // through to the default view — a mistyped or stale link should read as
  // "not here", not as a mysteriously empty gallery.
  // ErrorBoundary OUTSIDE Suspense: Suspense only handles the pending
  // load — a rejected chunk import would otherwise unmount the root.
  if (!isKnownAppPath(location.pathname)) {
    return (
      <div className="h-dvh">
        <ErrorBoundary>
          <Suspense fallback={null}>
            <NotFoundPage onBack={() => navigate('/')} />
          </Suspense>
        </ErrorBoundary>
      </div>
    )
  }

  if (parseSettingsRoute(location.pathname) !== null) {
    return (
      <ErrorBoundary>
        <div className="flex h-dvh flex-col">
          <AppShellLazy daemon={settingsDaemon !== undefined} />
          <div className="min-h-0 flex-1">
            <Suspense fallback={<LazyPageFallback heightClass="h-full" message="Loading…" />}>
              <SettingsPage daemon={settingsDaemon} onDisconnected={() => setForcedBrowser(true)} />
            </Suspense>
          </div>
        </div>
      </ErrorBoundary>
    )
  }

  // The 'Work in this browser instead' escape hatch opts out of the pairing
  // fragment entirely, so once it's set both daemon branches are skipped.
  if (!forcedBrowser) {
    // Both pairing paths converge here: the legacy #wb= fragment carries
    // its token inline; the grant flow resolved its token via the POST
    // exchange above. Either way the daemon pages just get baseUrl+token.
    if (daemonConnection.status === 'paired' || grantPaired !== null) {
      const payload =
        daemonConnection.status === 'paired'
          ? daemonConnection.payload
          : {
              baseUrl: (grantPaired as { daemonBaseUrl: string }).daemonBaseUrl,
              workspaceId: undefined,
              path: undefined,
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
          <div className="flex h-dvh flex-col">
            <AppShellLazy
              daemon={true}
              workspaces={daemonWorkspaces}
              onWorkInBrowser={() => setForcedBrowser(true)}
            />
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={<LazyPageFallback heightClass="h-full" message="Connecting to daemon…" />}
              >
                {daemonView.kind === 'index' ? (
                  <DaemonIndexPage
                    daemonBaseUrl={payload.baseUrl}
                    token={pairedToken}
                    workspace={daemonView.workspace}
                    onWorkspaceResolved={(workspace) => setDaemonView({ kind: 'index', workspace })}
                    onOpenDocument={(workspace, path) =>
                      setDaemonView({ kind: 'document', workspace, path })
                    }
                  />
                ) : (
                  <DaemonDocumentPage
                    key={`${daemonView.workspace}:${daemonView.path}`}
                    daemonBaseUrl={payload.baseUrl}
                    workspaceId={daemonView.workspace}
                    path={daemonView.path}
                    token={pairedToken}
                    onNavigateBack={() =>
                      setDaemonView({ kind: 'index', workspace: daemonView.workspace })
                    }
                  />
                )}
              </Suspense>
            </div>
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
              onClick={() => setForcedBrowser(true)}
              className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
            >
              Work in this browser instead
            </button>
          </div>
        </ErrorBoundary>
      )
    }
  }

  if (effectiveState.kind === 'invalid-config') {
    return (
      <ErrorBoundary>
        <main data-provider="invalid-config">
          <p>{effectiveState.message}</p>
        </main>
      </ErrorBoundary>
    )
  }

  if (effectiveState.kind === 'daemon') {
    return (
      <ErrorBoundary>
        <div className="flex h-dvh flex-col">
          <AppShellLazy
            daemon={true}
            workspaces={daemonWorkspaces}
            onWorkInBrowser={() => setForcedBrowser(true)}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense
              fallback={<LazyPageFallback heightClass="h-full" message="Connecting to daemon…" />}
            >
              {daemonView.kind === 'index' ? (
                <DaemonIndexPage
                  daemonBaseUrl={effectiveState.daemonBaseUrl}
                  token={daemonToken}
                  workspace={daemonView.workspace}
                  onWorkspaceResolved={(workspace) => setDaemonView({ kind: 'index', workspace })}
                  onOpenDocument={(workspace, path) =>
                    setDaemonView({ kind: 'document', workspace, path })
                  }
                />
              ) : (
                <DaemonDocumentPage
                  key={`${daemonView.workspace}:${daemonView.path}`}
                  daemonBaseUrl={effectiveState.daemonBaseUrl}
                  workspaceId={daemonView.workspace}
                  path={daemonView.path}
                  capabilities={effectiveState.capabilities}
                  token={daemonToken}
                  onNavigateBack={() =>
                    setDaemonView({ kind: 'index', workspace: daemonView.workspace })
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
        <AppShellLazy daemon={false} workspaces={browserWorkspaces} />
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
          // landing back here on the browser with no explanation was a
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
            {browserPath === undefined ? (
              // An index route lands on the document list. The editor mounts
              // only for a document route, whose in-editor switching it keeps
              // owning — App re-routes solely when the URL crosses the
              // list/editor boundary.
              <BrowserIndexPage
                onOpenDocument={(path) => {
                  if (browserHandle !== null) navigate(documentPath(browserHandle, path))
                }}
              />
            ) : (
              <BrowserDocumentPage
                capabilities={effectiveState.capabilities}
                initialPath={browserPath}
              />
            )}
          </Suspense>
        </div>
      </div>
    </ErrorBoundary>
  )
}
