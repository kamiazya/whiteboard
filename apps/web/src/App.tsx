import { lazy, Suspense, useState } from 'react'
import { BetaBanner } from './components/BetaBanner.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { useDaemonConnection } from './hooks/useDaemonConnection.js'
import { IndexedDBStore } from './lib/browser-local-store.js'
import { type ProviderState, resolveHostedProviderStateFromRaw } from './lib/provider.js'
import { createUserSettingsStore } from './lib/user-settings-store.js'
import { BrowserLocalCanvasPage } from './pages/BrowserLocalCanvasPage.js'

// Lazy so the daemon stack (DaemonBackend, ws-protocol, api client) stays out
// of the entry chunk — only sessions arriving via a #wb= pairing fragment pay
// for it, keeping the browser-local entry under the bundle-size budget.
const DaemonCanvasPage = lazy(() =>
  import('./pages/DaemonCanvasPage.js').then((m) => ({ default: m.DaemonCanvasPage })),
)

const _browserLocalStore = new IndexedDBStore()
const _userSettingsStore = createUserSettingsStore()

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

  // The 'Continue in browser-local' escape hatch opts out of the pairing
  // fragment entirely, so once it's set both daemon branches are skipped.
  if (!forcedBrowserLocal) {
    if (daemonConnection.status === 'paired') {
      const { payload } = daemonConnection
      return (
        // ErrorBoundary sits outside Suspense: a lazy-chunk load failure
        // propagates through Suspense's own error path to the nearest
        // boundary, which must be here to catch it.
        <ErrorBoundary>
          <Suspense
            fallback={
              <div
                role="status"
                aria-live="polite"
                className="flex h-dvh items-center justify-center text-sm text-muted-foreground"
              >
                Connecting to daemon…
              </div>
            }
          >
            <DaemonCanvasPage
              daemonBaseUrl={payload.baseUrl}
              workspaceId={payload.workspaceId}
              slug={payload.slug}
              token={payload.authMode === 'bootstrap' ? payload.bootstrapToken : undefined}
              onContinueBrowserLocal={() => setForcedBrowserLocal(true)}
              browserLocalStore={_browserLocalStore}
            />
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

  if (state.kind === 'invalid-config') {
    return (
      <ErrorBoundary>
        <main data-provider="invalid-config">
          <p>{state.message}</p>
        </main>
      </ErrorBoundary>
    )
  }

  if (state.kind === 'local-daemon') {
    return (
      <ErrorBoundary>
        <main data-provider="local-daemon" data-status="placeholder">
          <BetaBanner
            store={_userSettingsStore}
            message="Beta preview — features may be incomplete."
          />
          <BackendConfigChip state={state} />
          <h1>Whiteboard</h1>
        </main>
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
          store={_userSettingsStore}
          message="Beta preview — your data is stored only in this browser."
        />
        <BackendConfigChip state={state} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <BrowserLocalCanvasPage store={_browserLocalStore} capabilities={state.capabilities} />
        </div>
      </div>
    </ErrorBoundary>
  )
}
