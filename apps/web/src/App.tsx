import { resolveHostedProviderStateFromRaw, type ProviderState } from './lib/provider.js'
import { IndexedDBStore } from './lib/browser-local-store.js'
import { BrowserLocalCanvasPage } from './pages/BrowserLocalCanvasPage.js'

const _browserLocalStore = new IndexedDBStore()

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
  const state = providerState ?? _defaultProviderState

  if (state.kind === 'invalid-config') {
    return (
      <main data-provider="invalid-config">
        <p>{state.message}</p>
      </main>
    )
  }

  if (state.kind === 'local-daemon') {
    return (
      <main data-provider="local-daemon" data-status="placeholder">
        <BackendConfigChip state={state} />
        <h1>Whiteboard</h1>
      </main>
    )
  }

  return (
    <>
      <BackendConfigChip state={state} />
      <BrowserLocalCanvasPage store={_browserLocalStore} />
    </>
  )
}
