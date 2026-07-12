import { readDaemonTokenOnce } from '@kamiazya/whiteboard-mcp/api-client'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BetaBanner } from './components/BetaBanner.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { useDaemonConnection } from './hooks/useDaemonConnection.js'
import {
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
// Excalidraw + useCanvasSync (which imports loro-crdt), and it is the
// default render path (no daemon, no pairing fragment) — so it was the one
// making Excalidraw/loro-crdt part of every session's initial paint even
// though DaemonCanvasPage above was already lazy. Module-scope side effects
// that must run before React lifecycle begins (browserLocalStore,
// userSettingsStore, provider-state resolution just below) stay at THIS
// file's module scope, unaffected by which page component is lazy.
const BrowserLocalCanvasPage = lazy(() =>
  import('./pages/BrowserLocalCanvasPage.js').then((m) => ({ default: m.BrowserLocalCanvasPage })),
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

const browserLocalStore = new IndexedDBStore()
const userSettingsStore = createUserSettingsStore()

const _defaultProviderState: ProviderState = resolveHostedProviderStateFromRaw(
  typeof window !== 'undefined'
    ? ((window as { __WHITEBOARD_RUNTIME_CONFIG__?: unknown }).__WHITEBOARD_RUNTIME_CONFIG__ ?? {})
    : {},
  typeof window !== 'undefined' ? window.location.origin : undefined,
)

interface AppProps {
  providerState?: ProviderState
}

interface BackendConfigChipProps {
  // invalid-config renders its own error page and never shows the chip;
  // excluding it here lets the compiler prove that instead of a silent
  // 'Browser only' fallback.
  state: Exclude<ProviderState, { kind: 'invalid-config' }>
}

// Suspense fallback shared by every lazy page chunk (DaemonCanvasPage and
// BrowserLocalCanvasPage). The height class differs by mount site (root
// fills the viewport; the in-banner branches fill the flex row under it), so
// it's a prop; message is also a prop so the daemon-specific and
// backend-agnostic mount sites show accurate copy without duplicating this
// component.
function LazyPageFallback({ heightClass, message }: { heightClass: string; message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex ${heightClass} items-center justify-center text-sm text-muted-foreground`}
    >
      {message}
    </div>
  )
}

// Reports the configured storage backend only — this reflects runtime
// config, not a live connection/detection probe. Do not claim 'Connected'
// or 'Daemon unavailable' here; that needs an actual live probe.
// Fixed-positioned overlay: the canvas page owns the full viewport (h-dvh),
// so an in-flow sibling would push it down and create a page scrollbar.
function BackendConfigChip({ state }: BackendConfigChipProps) {
  const label =
    state.kind === 'local-daemon'
      ? `Configured for local daemon at ${state.daemonBaseUrl}`
      : 'Browser only'

  return (
    <div
      data-testid="backend-config-chip"
      className="fixed right-2 bottom-2 z-50 flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground shadow-sm"
    >
      {label}
    </div>
  )
}

export function App({ providerState }: AppProps) {
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

  // Read once at mount: a bookmarked/shared `/local/:canvasId` deep link
  // seeds which browser-local canvas to open. BrowserLocalCanvasPage owns
  // all subsequent URL<->canvas-id sync itself (switching canvases, back/
  // forward) once mounted — this is only the cold-load entry point.
  const [initialBrowserLocalCanvasId] = useState(
    () => parseBrowserLocalRoute(location.pathname)?.canvasId,
  )

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
  }, [daemonView, navigate])

  // URL -> state: handles the browser back/forward buttons (and, in
  // principle, any other code path that changes the route without going
  // through setDaemonView). Skips its own first run so it never overrides
  // the payload-preferring lazy initializer above with a stale pathname
  // that hasn't caught up to the #wb= sync effect yet.
  const isFirstRouteSyncRef = useRef(true)
  useEffect(() => {
    if (isFirstRouteSyncRef.current) {
      isFirstRouteSyncRef.current = false
      return
    }
    const parsed = parseDaemonRoute(location.pathname)
    if (parsed !== null) setDaemonView(parsed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

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

  // The 'Continue in browser-local' escape hatch opts out of the pairing
  // fragment entirely, so once it's set both daemon branches are skipped.
  if (!forcedBrowserLocal) {
    if (daemonConnection.status === 'paired') {
      const { payload } = daemonConnection
      const pairedToken = payload.authMode === 'bootstrap' ? payload.bootstrapToken : undefined
      return (
        // ErrorBoundary sits outside Suspense: a lazy-chunk load failure
        // propagates through Suspense's own error path to the nearest
        // boundary, which must be here to catch it.
        <ErrorBoundary>
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

  const state = providerState ?? _defaultProviderState

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
          <BackendConfigChip state={effectiveState} />
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
  // canvas instead of pushing the h-dvh canvas page past the viewport (which
  // would add a page scrollbar). The canvas fills the remaining height; the
  // wrapper clips the canvas page's own h-dvh to that remaining space.
  return (
    <ErrorBoundary>
      <div className="flex h-dvh flex-col">
        <BetaBanner
          store={userSettingsStore}
          message="Beta preview — your data is stored only in this browser."
        />
        <BackendConfigChip state={effectiveState} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<LazyPageFallback heightClass="h-full" message="Loading…" />}>
            <BrowserLocalCanvasPage
              store={browserLocalStore}
              capabilities={effectiveState.capabilities}
              initialCanvasId={initialBrowserLocalCanvasId}
            />
          </Suspense>
        </div>
      </div>
    </ErrorBoundary>
  )
}
