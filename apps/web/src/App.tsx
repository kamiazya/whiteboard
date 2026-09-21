import { readDaemonTokenOnce } from '@kamiazya/whiteboard-daemon-client/api-client'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppShellLazy } from './components/AppShellLazy.js'

// Lazy: the not-found page renders on rare, dead-end navigations only —
// it must not ride the critical-path bundle.
const NotFoundPage = lazy(() =>
  import('./components/status/NotFoundPage.js').then((m) => ({ default: m.NotFoundPage })),
)

import type { DaemonConnectionTarget } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { DocumentPageSkeleton } from './components/DocumentPageSkeleton.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { LinkPairingPending } from './components/LinkPairingPending.js'
import { useDaemonConnection } from './hooks/useDaemonConnection.js'
import { useDaemonThemeFonts } from './hooks/useDaemonThemeFonts.js'
import { useLinkPairing } from './hooks/useLinkPairing.js'
import {
  browserWorkspaceIdentitySnapshot,
  browserWorkspaceMatches,
  subscribeBrowserWorkspaceIdentity,
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

import { useShellWorkspaces } from './hooks/use-shell-workspaces.js'
import { useWorkspaceAddressSync } from './hooks/use-workspace-address-sync.js'
import {
  documentPath,
  isKnownAppPath,
  parseSettingsRoute,
  parseWorkspaceRoute,
  type WorkspaceRoute,
} from './lib/app-routes.js'
import type { ConnectedDaemon } from './lib/daemon-auth-fetch.js'
import { passkeySupported } from './lib/passkey-attestation.js'
import { type ProviderState, resolveHostedProviderStateFromRaw } from './lib/provider.js'
import { findReplicaForHandle } from './lib/replicas.js'
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

// ADR-0023's offline read: mounted only when the daemon is unreachable and
// a replica of the addressed workspace exists — the rarest branch, and the
// heaviest (loro-adapter + the canvas viewer), so it stays a chunk.
const ReplicaReadPage = lazy(() =>
  import('./pages/ReplicaReadPage.js').then((m) => ({ default: m.ReplicaReadPage })),
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

// A pairing link's target, as a view. One definition for both arrivals: the
// `#wb=` payload read on this page load, and the target a consent round trip
// carried back in the pairing transaction.
function daemonViewForTarget(target: DaemonConnectionTarget): DaemonView {
  if (target.workspaceId !== undefined && target.path !== undefined) {
    return { kind: 'document', workspace: target.workspaceId, path: target.path }
  }
  return { kind: 'index', workspace: target.workspaceId }
}

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
  }, [])

  // Silent renewal: a later visit to a hosted origin that already holds a
  // pairing grant reconnects without any redirect — the browser-enforced
  // Origin header against the daemon's persisted grant is the whole
  // credential (POST /api/pairing/token, grantType 'origin'). Gated to the
  // no-fragment cold load: an in-flight #wb=/#wb-grant flow always wins.
  // The stored daemon answered the silent renewal with nothing usable:
  // `'refused'` (reached, HTTP 403 — a revoked grant) or `'unreachable'`
  // (any other non-ok response, or the daemon could not be reached at
  // all). Held so the render can offer the replica read (ADR-0023) instead
  // of silently landing on the browser's own workspaces, and so the two
  // are told apart (ADR-0042 decision 4: a removed member is shown a
  // stated ban, not a page that reads like a network blip).
  const [daemonRenewal, setDaemonRenewal] = useState<'refused' | 'unreachable' | null>(null)
  const attemptedRenewalRef = useRef(false)
  // Re-run by ReplicaReadPage's Reconnect action as well as the cold-load
  // effect below — both go through the SAME gate and the SAME state
  // setters, so a manual reconnect can never diverge from what a fresh
  // page load would have decided.
  const attemptRenewal = useCallback(async () => {
    if (isPairRoute) return
    if (daemonConnection.status !== 'none') return
    if (grantConnection !== null) return
    if ((providerState ?? defaultProviderState).kind !== 'browser') return
    const storedBaseUrl = userSettingsStore.load().storage.daemonBaseUrl
    if (storedBaseUrl === undefined) return
    const result = await renewPairingToken({
      daemonBaseUrl: storedBaseUrl,
      fetch: globalThis.fetch.bind(globalThis),
    })
    // 'paired' connects; 'identity-mismatch' must ALSO land in state — it
    // is the fail-closed warning ("this daemon's identity changed"), and
    // dropping it here would silently swallow the whole verification.
    if (result.status === 'paired' || result.status === 'identity-mismatch') {
      setDaemonRenewal(null)
      setGrantConnection(result)
    } else {
      setDaemonRenewal(result.status === 'refused' ? 'refused' : 'unreachable')
    }
  }, [isPairRoute, daemonConnection.status, grantConnection, providerState])
  useEffect(() => {
    if (attemptedRenewalRef.current) return
    attemptedRenewalRef.current = true
    void attemptRenewal()
    // Cold-load decision over mount-time facts; the ref guards StrictMode.
    // attemptRenewal is intentionally omitted from the deps — its own
    // identity changes with the gate values it closes over, and re-running
    // this effect for that would defeat the once-per-mount ref guard above.
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
    if (daemonConnection.status === 'paired') return daemonViewForTarget(daemonConnection.payload)
    return parseWorkspaceRoute(location.pathname) ?? { kind: 'index' }
  })

  // A `#wb=` pairing link is an INTENT, not a connection: it carries no
  // credential, so it is resolved through the pairing grant before anything
  // can talk to the daemon (hooks/useLinkPairing.ts owns both halves).
  const { failed: linkPairingFailed } = useLinkPairing({
    payload: daemonConnection.status === 'paired' ? daemonConnection.payload : undefined,
    enabled: !isPairRoute,
    grant: grantConnection,
    onResolved: setGrantConnection,
    onTarget: (target) => setDaemonView(daemonViewForTarget(target)),
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
      ? { kind: 'browser' as const }
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
  // Mirrors `attemptRenewal`'s own gates (above): true for exactly the
  // window where a stored daemon connection's silent renewal has been
  // attempted but has not yet produced an outcome — `daemonKept` cannot
  // turn true before then, so the browser-keeper address rewrite must not
  // draw a conclusion yet either (see the field's own comment).
  const awaitingDaemonRenewal =
    !isPairRoute &&
    daemonConnection.status === 'none' &&
    grantConnection === null &&
    daemonRenewal === null &&
    state.kind === 'browser' &&
    userSettingsStore.load().storage.daemonBaseUrl !== undefined
  useWorkspaceAddressSync({
    location,
    navigate,
    isPairRoute,
    browserHandle,
    daemonKept,
    daemonView,
    setDaemonView,
    userSettingsStore,
    awaitingDaemonRenewal,
  })

  // ADR-0023's offline read: the addressed workspace is daemon-kept, the
  // daemon answered the renewal with nothing usable, and this browser holds
  // a replica of it. Looked up by EITHER identity layer — the registry keys
  // by the canonical id and captured the segment at sync time, because
  // offline is exactly when a segment cannot be resolved.
  const replicaMatch =
    daemonRenewal !== null && !daemonKept && browserRoute?.workspace !== undefined
      ? findReplicaForHandle(userSettingsStore.load(), browserRoute.workspace)
      : null

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
  // A `#wb=` payload supplies the daemon's ADDRESS and never a credential,
  // so the token has exactly two sources: the pairing grant this page
  // obtained, or the daemon's own injection when it served the page.
  const shellDaemonToken = grantPaired !== null ? grantPaired.token : (daemonToken ?? undefined)
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

  useDaemonThemeFonts(daemonShellTarget)

  const { daemonWorkspaces, browserWorkspaces } = useShellWorkspaces({
    daemonShellTarget,
    navigate,
    setDaemonRoute: setDaemonView,
  })

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
  }, [daemonConnection.status])

  useEffect(() => {
    if (grantConnection?.status !== 'paired') return
    userSettingsStore.update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: grantConnection.daemonBaseUrl },
    }))
  }, [grantConnection?.status])

  // /settings renders on its own route ahead of (and independent from) the
  // daemon/browser branch below, so its daemon connection needs
  // resolving here rather than reusing a `payload`/`effectiveState` local
  // that only exists inside one of those branches' own scope.
  const grantPairedForSettings = grantConnection?.status === 'paired' ? grantConnection : null
  const providerStateForSettings = providerState ?? defaultProviderState
  const settingsDaemon: ConnectedDaemon | undefined = forcedBrowser
    ? undefined
    : grantPairedForSettings !== null
      ? { baseUrl: grantPairedForSettings.daemonBaseUrl, token: grantPairedForSettings.token }
      : providerStateForSettings.kind === 'daemon'
        ? { baseUrl: providerStateForSettings.daemonBaseUrl, token: daemonToken ?? null }
        : undefined

  // Tells `openDocumentStore` (S4b) which daemon this tab is connected to,
  // so a daemon-kept workspace's replica routes to a real session-key
  // source instead of the withheld answer an unconnected ref gets.
  // `credentials` is read the same way PromoteWorkspaceSection reads it —
  // undefined where WebAuthn is unsupported, so `bindPasskeySession` answers
  // `no-passkey` rather than throwing on a missing API.
  //
  // Dynamically imported rather than statically, like every other lib this
  // file only NEEDS once a daemon resolves: a static import pulled the
  // session-key holder's whole chain into App's own critical-path chunk and
  // tripped `smoke:bundle-size`'s modulepreload budget (154.9 KB against a
  // 152 KB budget, measured before this became dynamic).
  useEffect(() => {
    const daemon =
      settingsDaemon === undefined
        ? null
        : {
            baseUrl: settingsDaemon.baseUrl,
            token: settingsDaemon.token,
            credentials: passkeySupported() ? globalThis.navigator.credentials : undefined,
          }
    let cancelled = false
    import('./lib/replica-store.js').then(({ connectReplicaKeeper }) => {
      if (!cancelled) connectReplicaKeeper(daemon)
    })
    return () => {
      cancelled = true
    }
  }, [settingsDaemon?.baseUrl, settingsDaemon?.token])

  // The daemon-served /pair consent page (pairing-grant flow) — rendered
  // in place of every other view; approving needs the R3-injected token.
  if (isPairRoute) {
    return (
      <Suspense fallback={<LazyPageFallback heightClass="h-dvh" message="Loading…" />}>
        <PairConsentPage daemonToken={daemonToken} />
      </Suspense>
    )
  }

  // A pairing link is being turned into a connection (silent renewal, or the
  // hop to /pair about to happen). Rendering the browser's own workspaces
  // here would flash the WRONG keeper's documents for as long as that takes,
  // and on the consent path the user would watch them disappear again.
  // Only while the outcome is still OPEN. An 'identity-mismatch' or 'error'
  // result is a resolution — it has its own banner further down, and
  // swallowing it here would leave the page reading "Connecting…" forever
  // over a daemon that had already failed its identity check.
  if (
    !forcedBrowser &&
    daemonConnection.status === 'paired' &&
    grantPaired === null &&
    (grantConnection === null || grantConnection.status === 'none')
  ) {
    return (
      <LinkPairingPending
        daemonBaseUrl={daemonConnection.payload.baseUrl}
        failed={linkPairingFailed}
        onWorkInBrowser={() => setForcedBrowser(true)}
      />
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
          {/* The switcher belongs here for the reason the shell states about
              its own mark: it opens on every page, so there is always
              something for the popover to say. Without a source this route
              was the exception — every child of that popover is conditional,
              and here they were all false at once, because only DOCUMENT
              pages publish shell status so the connection is null too. The
              control opened onto nothing.

              Keyed off `settingsDaemon` exactly as `daemon` beside it is, so
              the two cannot answer different keepers for one render. */}
          <AppShellLazy
            daemon={settingsDaemon !== undefined}
            workspaces={settingsDaemon === undefined ? browserWorkspaces : daemonWorkspaces}
          />
          <div className="min-h-0 flex-1">
            <Suspense fallback={<LazyPageFallback heightClass="h-full" message="Loading…" />}>
              <SettingsPage
                daemon={settingsDaemon}
                onDisconnected={() => setForcedBrowser(true)}
                workspaceId={settingsDaemon === undefined ? undefined : daemonView.workspace}
              />
            </Suspense>
          </div>
        </div>
      </ErrorBoundary>
    )
  }

  // The 'Work in this browser instead' escape hatch opts out of the pairing
  // fragment entirely, so once it's set both daemon branches are skipped.
  if (!forcedBrowser) {
    // One pairing path now: every daemon connection a hosted page has is a
    // grant. A `#wb=` fragment only decides WHICH daemon and what to open —
    // the effect above turns it into the grant this branch reads.
    if (grantPaired !== null) {
      // What to OPEN is daemonView's, from the link's payload or the target
      // the consent round trip carried back; this branch only needs where to
      // reach and what to present.
      const pairedBaseUrl = grantPaired.daemonBaseUrl
      const pairedToken = grantPaired.token
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
                    daemonBaseUrl={pairedBaseUrl}
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
                    daemonBaseUrl={pairedBaseUrl}
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
            className="flex shrink-0 items-center justify-between gap-2 bg-destructive/10 px-chrome py-1.5 text-xs text-destructive"
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
            className="flex shrink-0 items-center justify-between gap-2 bg-destructive/10 px-chrome py-1.5 text-xs text-destructive"
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
            {replicaMatch !== null ? (
              <ReplicaReadPage
                workspaceId={replicaMatch.workspaceId}
                {...(replicaMatch.displayName === undefined
                  ? {}
                  : { displayName: replicaMatch.displayName })}
                syncedAt={replicaMatch.syncedAt}
                daemonBaseUrl={replicaMatch.daemonBaseUrl}
                // Non-null here by construction: replicaMatch only exists
                // when daemonRenewal !== null (see its own definition above).
                renewal={daemonRenewal ?? 'unreachable'}
                onReconnect={attemptRenewal}
              />
            ) : browserPath === undefined ? (
              // An index route lands on the document list. The editor mounts
              // only for a document route, whose in-editor switching it keeps
              // owning — App re-routes solely when the URL crosses the
              // list/editor boundary.
              <BrowserIndexPage
                onOpenDocument={(path) => {
                  if (browserHandle !== null) navigate(documentPath(browserHandle, path))
                }}
                // A Back during a lazy destination's load aborts the
                // startTransition and leaves this page mounted. The location
                // OBJECT is what still moves — its IDENTITY is new on every
                // navigation, where `location.key` is per-history-entry and
                // a Back restores the SAME key it mounted with (measured:
                // keyed on it, the stale list survived the Back).
                revision={location}
              />
            ) : (
              <BrowserDocumentPage initialPath={browserPath} />
            )}
          </Suspense>
        </div>
      </div>
    </ErrorBoundary>
  )
}
