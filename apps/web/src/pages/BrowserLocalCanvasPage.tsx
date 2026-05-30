import { derivePageState } from './browser-local-page-state.js'
import { useBrowserLocalCanvasController } from './use-browser-local-canvas-controller.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'

interface BrowserLocalCanvasPageProps {
  store: BrowserLocalStore
}

export function BrowserLocalCanvasPage({ store }: BrowserLocalCanvasPageProps) {
  const { snapshot, persistence, cleanupCompleted, cleanupError, updateScene, triggerCleanup, startFresh } =
    useBrowserLocalCanvasController(store)

  const pageState = derivePageState({ snapshot, persistence, cleanupCompleted })

  if (pageState.kind === 'load-degraded') {
    return (
      <div role="alert" aria-live="assertive">
        <p>{pageState.message}</p>
        <button type="button" onClick={() => void startFresh()}>
          Start fresh
        </button>
      </div>
    )
  }

  if (pageState.kind === 'cleanup-completed') {
    return <div data-testid="cleanup-completed">Canvas removed.</div>
  }

  if (pageState.kind === 'loading') {
    return <div role="status" aria-live="polite">Loading…</div>
  }

  const elements = pageState.snapshot.scene.elements as Array<{ type: string; id: string }>

  function addRectangle() {
    const next = [...elements, { type: 'rectangle', id: crypto.randomUUID() }]
    updateScene(next)
  }

  return (
    <main>
      <header>
        <h1>{pageState.snapshot.name}</h1>
        <span>{pageState.persistence.kind}</span>
        {cleanupError && (
          <div role="alert" aria-live="assertive">{cleanupError}</div>
        )}
        <button type="button" onClick={addRectangle}>
          Add rectangle
        </button>
        <span data-testid="element-count">{elements.length}</span>
        <button
          type="button"
          onClick={() => void triggerCleanup()}
          aria-label="Delete canvas"
        >
          Delete
        </button>
      </header>
      <div data-testid="canvas-editor" />
    </main>
  )
}
