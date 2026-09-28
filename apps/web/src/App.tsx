import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  BrowserWorkspaceScreen,
  ConnectingScreen,
  DaemonWorkspaceScreen,
  InvalidConfigScreen,
  NotFoundScreen,
  SettingsScreen,
} from './app-screens.js'
import { LazyPageFallback } from './components/LazyPageFallback.js'
import { useDaemonReconnect } from './hooks/use-daemon-reconnect.js'
import { useDaemonShellTarget, useReplicaKeeper } from './hooks/use-daemon-session.js'
import { useDaemonThemeFonts } from './hooks/useDaemonThemeFonts.js'
import {
  browserWorkspaceIdentitySnapshot,
  subscribeBrowserWorkspaceIdentity,
} from './lib/browser-workspace-id.js'

// Lazy: this page decodes an arriving workspace record, so it reaches loro —
// which must stay off the entry chunk (entry-graph-loro-free.test.ts) — and it
// renders on a rare, dedicated top-level navigation.
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
  renewalPending,
  replicaRead,
  settingsDaemon,
  shellDaemon,
} from './lib/session-keeper.js'
import { createUserSettingsStore } from './lib/user-settings-store.js'
import { workspaceHandleOrNull } from './lib/workspace-handle.js'

// Which daemon-mode view is showing: the canvas gallery, or a specific open
// document. `key` on the DaemonDocumentPage mount forces a clean remount
// (fresh controller/backend) on every index -> document transition instead of
// reusing a previous document's identity. It IS the route — app-routes.ts's
// parse/build functions keep the two in sync — and a cold load's URL seeds it
// (a bookmark, a shared link, or a reload).
type DaemonView = WorkspaceRoute

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

  const [forcedBrowser, setForcedBrowser] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // The keeper-served transfer receiver is its OWN surface, not a daemon view:
  // `parseWorkspaceRoute('/receive-transfer')` is null, so without this guard
  // the daemonView -> URL sync effect below navigates to '/' and drops the
  // fragment the sender put there — which is the whole handshake.
  const isReceiveTransferRoute = location.pathname === '/receive-transfer'

  const state = providerState ?? defaultProviderState
  const { connection, renewal, attemptRenewal, awaitingDaemonRenewal } = useDaemonReconnect({
    providerKind: state.kind,
    userSettingsStore,
  })

  // Lazy initializer: the pathname at mount time is fixed for the life of the
  // mount.
  const [daemonView, setDaemonView] = useState<DaemonView>(
    () => parseWorkspaceRoute(location.pathname) ?? { kind: 'index' },
  )

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
  // State -> URL: fires whenever daemonView changes from in-app navigation
  // (onOpenDocument/onNavigateBack below). The very first sync uses `replace`;
  // every subsequent sync pushes, so browser back/forward has real steps to
  // walk.
  const effectiveState = effectiveProviderState(state, forcedBrowser)
  // Derived here rather than in the render tail because the URL-sync effect
  // below needs it: hooks cannot be conditional, so they run under BOTH
  // keepers and something has to tell them which one this is.
  const daemonKept = daemonKeepsSession({
    forcedBrowser,
    connected: connection !== null,
    effectiveState,
  })
  useWorkspaceAddressSync({
    location,
    navigate,
    browserHandle,
    daemonKept,
    daemonView,
    setDaemonView,
    userSettingsStore,
    awaitingDaemonRenewal,
  })

  const replica = replicaRead({
    renewal,
    daemonKept,
    route: browserRoute,
    settings: userSettingsStore.load(),
  })

  // Which daemon the SHELL is talking to. Hoisted above the render branches
  // because a hook cannot live inside one.
  const shell = shellDaemon({ forcedBrowser, connection, effectiveState })
  const daemonShellTarget = useDaemonShellTarget(shell)

  useDaemonThemeFonts(daemonShellTarget)

  const { daemonWorkspaces, browserWorkspaces } = useShellWorkspaces({
    daemonShellTarget,
    navigate,
    setDaemonRoute: setDaemonView,
  })

  // /settings renders on its own route ahead of (and independent from) the
  // daemon/browser branch below, so its daemon connection is resolved here
  // rather than inside one of those branches' own scope. Off the RAW provider
  // state, not the effective one: the escape hatch is its own `forcedBrowser`
  // argument.
  const settings = settingsDaemon({ forcedBrowser, connection, providerState: state })

  useReplicaKeeper(settings)

  // The keeper-served /receive-transfer surface — rendered in place of every
  // other view.
  if (isReceiveTransferRoute) {
    return (
      <Suspense fallback={<LazyPageFallback heightClass="h-dvh" message="Loading…" />}>
        <ReceiveTransferPage />
      </Suspense>
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

  if (renewalPending({ forcedBrowser, awaitingDaemonRenewal, connected: connection !== null })) {
    return <ConnectingScreen />
  }

  // The 'Work in this browser instead' escape hatch opts out of the daemon
  // this page reconnected to, so once it's set both daemon branches are
  // skipped.
  if (!forcedBrowser && connection !== null) {
    return (
      <DaemonWorkspaceScreen
        daemonBaseUrl={connection.daemonBaseUrl}
        token={connection.token}
        view={daemonView}
        onView={setDaemonView}
        onWorkInBrowser={() => setForcedBrowser(true)}
        workspaces={daemonWorkspaces}
      />
    )
  }

  if (effectiveState.kind === 'invalid-config') {
    return <InvalidConfigScreen message={effectiveState.message} />
  }

  if (effectiveState.kind === 'daemon') {
    return (
      <DaemonWorkspaceScreen
        daemonBaseUrl={effectiveState.daemonBaseUrl}
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
