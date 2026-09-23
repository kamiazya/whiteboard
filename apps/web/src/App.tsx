import { readDaemonTokenOnce } from '@kamiazya/whiteboard-daemon-client/api-client'
import type { DaemonConnectionTarget } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  BrowserWorkspaceScreen,
  DaemonWorkspaceScreen,
  InvalidConfigScreen,
  LazyPageFallback,
  NotFoundScreen,
  PairingFailedScreen,
  SettingsScreen,
} from './app-screens.js'
import { LinkPairingPending } from './components/LinkPairingPending.js'
import { useDaemonGrant } from './hooks/use-daemon-grant.js'
import {
  useDaemonShellTarget,
  useRememberedDaemon,
  useReplicaKeeper,
} from './hooks/use-daemon-session.js'
import { useDaemonConnection } from './hooks/useDaemonConnection.js'
import { useDaemonThemeFonts } from './hooks/useDaemonThemeFonts.js'
import { useLinkPairing } from './hooks/useLinkPairing.js'
import {
  browserWorkspaceIdentitySnapshot,
  subscribeBrowserWorkspaceIdentity,
} from './lib/browser-workspace-id.js'

// Lazy: the /pair consent page transitively pulls daemon-api-client's zod
// schema chain, which must stay off the entry chunk's critical path (see
// apps/web/scripts/smoke-bundle-size.mjs). It renders on a rare, dedicated
// top-level navigation, so the extra chunk fetch is invisible.
const PairConsentPage = lazy(() =>
  import('./pages/PairConsentPage.js').then((m) => ({ default: m.PairConsentPage })),
)

// Lazy for the same reason as /pair, and one more: this page decodes an
// arriving workspace record, so it reaches loro — which must stay off the
// entry chunk (entry-graph-loro-free.test.ts).
const ReceiveTransferPage = lazy(() =>
  import('./pages/ReceiveTransferPage.js').then((m) => ({ default: m.ReceiveTransferPage })),
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
import { type ProviderState, resolveHostedProviderStateFromRaw } from './lib/provider.js'
import {
  browserDocumentPath,
  daemonKeepsSession,
  effectiveProviderState,
  linkPairingPending,
  replicaRead,
  sessionBanner,
  settingsDaemon,
  shellDaemon,
} from './lib/session-keeper.js'
import { createUserSettingsStore } from './lib/user-settings-store.js'
import { workspaceHandleOrNull } from './lib/workspace-handle.js'

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

/**
 * Where a daemon-kept session starts, from the facts that are fixed for the
 * life of the mount.
 *
 * A `#wb=` fragment carrying both workspaceId and path skips straight to the
 * document (the existing deep-link contract); a workspace-only fragment is
 * still a valid target (see daemon-connection-payload.ts's refine) and starts
 * on the gallery pre-scoped to that workspace rather than whichever workspace
 * the daemon happens to list first. Absent a fragment — the daemon's
 * runtime-config path, or a same-origin cold load of a `/w/:workspaceId/d/:path`
 * or `/w/:workspaceId` URL (a bookmark, a shared link, or R3's "Open the local
 * app" deep link) — the URL itself seeds the view.
 */
function initialDaemonView(
  linkTarget: DaemonConnectionTarget | undefined,
  pathname: string,
): DaemonView {
  if (linkTarget !== undefined) return daemonViewForTarget(linkTarget)
  return parseWorkspaceRoute(pathname) ?? { kind: 'index' }
}

interface AppProps {
  providerState?: ProviderState
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
  // What the `#wb=` fragment on THIS page load named, or undefined: the
  // daemon's address and what to open. Resolved once — four call sites below
  // each narrowed the connection for themselves, and a reader had to check
  // that they still agreed.
  const linkPayload = daemonConnection.status === 'paired' ? daemonConnection.payload : undefined
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

  // The keeper-served transfer receiver, for the same reason /pair needs a
  // guard: `parseWorkspaceRoute('/receive-transfer')` is null, so without
  // this the daemonView -> URL sync effect below navigates to '/' and drops
  // the fragment the sender put there — which is the whole handshake.
  const isReceiveTransferRoute = location.pathname === '/receive-transfer'

  const [grantErrorDismissed, setGrantErrorDismissed] = useState(false)

  const state = providerState ?? defaultProviderState
  const {
    grantConnection,
    setGrantConnection,
    grantPaired,
    daemonRenewal,
    attemptRenewal,
    awaitingDaemonRenewal,
  } = useDaemonGrant({
    isPairRoute,
    daemonConnected: daemonConnection.status !== 'none',
    providerKind: state.kind,
    userSettingsStore,
  })

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
  const [daemonView, setDaemonView] = useState<DaemonView>(() =>
    initialDaemonView(linkPayload, location.pathname),
  )

  // A `#wb=` pairing link is an INTENT, not a connection: it carries no
  // credential, so it is resolved through the pairing grant before anything
  // can talk to the daemon (hooks/useLinkPairing.ts owns both halves).
  const { failed: linkPairingFailed } = useLinkPairing({
    payload: linkPayload,
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
  const browserHandle = workspaceHandleOrNull(browserIdentity)
  const browserRoute = parseWorkspaceRoute(location.pathname)
  const browserPath = browserDocumentPath(browserRoute)

  // Keeps the address bar in sync with `daemonView` in both directions.
  //
  // State -> URL: fires whenever daemonView changes, whether from in-app
  // navigation (onOpenDocument/onNavigateBack below) or from the #wb=
  // consume-once fragment establishing the initial view above. The very
  // first sync uses `replace` so the raw pairing URL never lingers as a
  // separate history entry the user could "back" into (it's already been
  // consumed and re-visiting it would silently do nothing); every
  // subsequent sync pushes, so browser back/forward has real steps to walk.
  const effectiveState = effectiveProviderState(state, forcedBrowser)
  // Derived here rather than in the render tail because the URL-sync effect
  // below needs it: hooks cannot be conditional, so they run under BOTH
  // keepers and something has to tell them which one this is.
  const daemonKept = daemonKeepsSession({
    forcedBrowser,
    linkPaired: linkPayload !== undefined,
    grantPaired: grantPaired !== null,
    effectiveState,
  })
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

  const replica = replicaRead({
    renewal: daemonRenewal,
    daemonKept,
    route: browserRoute,
    settings: userSettingsStore.load(),
  })

  // Which daemon the SHELL is talking to. Hoisted above the render branches
  // because a hook cannot live inside one, and the switcher has to work on
  // the pairing-link path too — that branch renders the same index page, so
  // leaving it out would have taken the deleted select away with nothing in
  // its place.
  const shell = shellDaemon({
    forcedBrowser,
    linkPayloadBaseUrl: linkPayload?.baseUrl,
    grant: grantPaired,
    effectiveState,
    injectedToken: daemonToken,
  })
  const daemonShellTarget = useDaemonShellTarget(shell)

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
  useRememberedDaemon({
    connected: linkPayload !== undefined,
    target: linkPayload,
    userSettingsStore,
  })

  // /settings renders on its own route ahead of (and independent from) the
  // daemon/browser branch below, so its daemon connection is resolved here
  // rather than inside one of those branches' own scope. Off the RAW provider
  // state, not the effective one: the escape hatch is its own `forcedBrowser`
  // argument.
  const settings = settingsDaemon({
    forcedBrowser,
    grant: grantPaired,
    providerState: state,
    injectedToken: daemonToken,
  })

  useReplicaKeeper(settings)

  // The keeper-served /receive-transfer surface — rendered in place of every
  // other view, and before the pair branch for no reason other than reading
  // order. Accepting needs the R3-injected token, same as /pair.
  if (isReceiveTransferRoute) {
    return (
      <Suspense fallback={<LazyPageFallback heightClass="h-dvh" message="Loading…" />}>
        <ReceiveTransferPage daemonToken={daemonToken} />
      </Suspense>
    )
  }

  // The daemon-served /pair consent page (pairing-grant flow) — rendered
  // in place of every other view; approving needs the R3-injected token.
  if (isPairRoute) {
    return (
      <Suspense fallback={<LazyPageFallback heightClass="h-dvh" message="Loading…" />}>
        <PairConsentPage daemonToken={daemonToken} />
      </Suspense>
    )
  }

  const pendingPairingBaseUrl = linkPairingPending({
    forcedBrowser,
    linkBaseUrl: linkPayload?.baseUrl,
    grantPaired: grantPaired !== null,
    grant: grantConnection,
  })
  if (pendingPairingBaseUrl !== null) {
    return (
      <LinkPairingPending
        daemonBaseUrl={pendingPairingBaseUrl}
        failed={linkPairingFailed}
        onWorkInBrowser={() => setForcedBrowser(true)}
      />
    )
  }

  if (!isKnownAppPath(location.pathname)) {
    return <NotFoundScreen onBack={() => navigate('/')} />
  }

  if (parseSettingsRoute(location.pathname) !== null) {
    return (
      <SettingsScreen
        daemon={settings}
        workspaceId={daemonView.workspace}
        onDisconnected={() => setForcedBrowser(true)}
        daemonWorkspaces={daemonWorkspaces}
        browserWorkspaces={browserWorkspaces}
      />
    )
  }

  // The 'Work in this browser instead' escape hatch opts out of the pairing
  // fragment entirely, so once it's set both daemon branches are skipped.
  // One pairing path now: every daemon connection a hosted page has is a
  // grant. A `#wb=` fragment only decides WHICH daemon and what to open —
  // the effect above turns it into the grant this branch reads, and
  // `daemonView` carries what to open.
  if (!forcedBrowser && grantPaired !== null) {
    return (
      <DaemonWorkspaceScreen
        daemonBaseUrl={grantPaired.daemonBaseUrl}
        token={grantPaired.token}
        view={daemonView}
        onView={setDaemonView}
        onWorkInBrowser={() => setForcedBrowser(true)}
        workspaces={daemonWorkspaces}
      />
    )
  }

  if (!forcedBrowser && daemonConnection.status === 'error') {
    return <PairingFailedScreen onWorkInBrowser={() => setForcedBrowser(true)} />
  }

  if (effectiveState.kind === 'invalid-config') {
    return <InvalidConfigScreen message={effectiveState.message} />
  }

  if (effectiveState.kind === 'daemon') {
    return (
      <DaemonWorkspaceScreen
        daemonBaseUrl={effectiveState.daemonBaseUrl}
        token={daemonToken}
        view={daemonView}
        onView={setDaemonView}
        onWorkInBrowser={() => setForcedBrowser(true)}
        workspaces={daemonWorkspaces}
      />
    )
  }

  return (
    <BrowserWorkspaceScreen
      workspaces={browserWorkspaces}
      banner={sessionBanner(grantConnection, grantErrorDismissed)}
      onDismissBanner={() => setGrantErrorDismissed(true)}
      replica={replica}
      onReconnect={attemptRenewal}
      path={browserPath}
      onOpenDocument={(path) => {
        if (browserHandle !== null) navigate(documentPath(browserHandle, path))
      }}
      // A Back during a lazy destination's load aborts the startTransition and
      // leaves this page mounted. The location OBJECT is what still moves —
      // its IDENTITY is new on every navigation, where `location.key` is
      // per-history-entry and a Back restores the SAME key it mounted with
      // (measured: keyed on it, the stale list survived the Back).
      revision={location}
    />
  )
}
