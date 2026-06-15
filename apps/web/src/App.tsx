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
        <h1>Whiteboard</h1>
      </main>
    )
  }

  return <BrowserLocalCanvasPage store={_browserLocalStore} />
}
