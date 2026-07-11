import { readDaemonTokenOnce } from '@kamiazya/whiteboard-mcp/api-client'
import { lazy, Suspense, useState } from 'react'
import { BetaBanner } from './components/BetaBanner.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { useDaemonConnection } from './hooks/useDaemonConnection.js'
import { IndexedDBStore } from './lib/browser-local-store.js'
import {
  BROWSER_LOCAL_CAPABILITIES,
  type ProviderState,
  resolveHostedProviderStateFromRaw,
} from './lib/provider.js'
import { createUserSettingsStore } from './lib/user-settings-store.js'
import { BrowserLocalCanvasPage } from './pages/BrowserLocalCanvasPage.js'

// Lazy so the daemon stack (DaemonBackend, ws-protocol, api client) stays out
// of the entry chunk — sessions arriving via a #wb= pairing fragment AND
// sessions with a runtime-config local-daemon provider state pay for it;
// pure browser-local sessions never import it, keeping that entry under the
// bundle-size budget.
const DaemonCanvasPage = lazy(() =>
  import('./pages/DaemonCanvasPage.js').then((m) => ({ default: m.DaemonCanvasPage })),
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
// transition instead of reusing a previous canvas's identity.
type DaemonView =
  | { kind: 'index'; workspaceId?: string }
  | { kind: 'canvas'; workspaceId: string; slug: string }

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

// Suspense fallback while the lazy daemon chunk loads. The height class
// differs by mount site (root fills the viewport; the local-daemon branch
// fills the flex row under the banner), so it's a prop; the copy stays shared
// so the two mount sites can't drift.
function DaemonConnectingFallback({ heightClass }: { heightClass: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex ${heightClass} items-center justify-center text-sm text-muted-foreground`}
    >
      Connecting to daemon…
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

  // A #wb= fragment carrying both workspaceId+slug skips straight to the
  // canvas (the existing deep-link contract); a workspace-only fragment is
  // still a valid target (see daemon-connection-payload.ts's refine) and
  // starts on the gallery pre-scoped to that workspace rather than
  // whichever workspace the daemon happens to list first. A slug-less AND
  // workspace-less fragment (or local-daemon's runtime-config path, which
  // never has a fragment at all) starts on the gallery unscoped. Lazy
  // initializer: daemonConnection's payload is fixed for the life of the
  // mount, so this never needs to react to it changing after the fact.
  const [daemonView, setDaemonView] = useState<DaemonView>(() => {
    if (daemonConnection.status !== 'paired') return { kind: 'index' }
    const { workspaceId, slug } = daemonConnection.payload
    if (workspaceId && slug) return { kind: 'canvas', workspaceId, slug }
    return { kind: 'index', workspaceId }
  })

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
          <Suspense fallback={<DaemonConnectingFallback heightClass="h-dvh" />}>
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
                onNavigateBack={() => setDaemonView({ kind: 'index' })}
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
            <Suspense fallback={<DaemonConnectingFallback heightClass="h-full" />}>
              {daemonView.kind === 'index' ? (
                <DaemonIndexPage
                  daemonBaseUrl={effectiveState.daemonBaseUrl}
                  token={daemonToken}
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
                  onNavigateBack={() => setDaemonView({ kind: 'index' })}
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
          <BrowserLocalCanvasPage
            store={browserLocalStore}
            capabilities={effectiveState.capabilities}
          />
        </div>
      </div>
    </ErrorBoundary>
  )
}
