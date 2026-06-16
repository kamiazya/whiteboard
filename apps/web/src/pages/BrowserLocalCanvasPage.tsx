import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { derivePageState } from './browser-local-page-state.js'
import { useBrowserLocalCanvasController } from './use-browser-local-canvas-controller.js'
import { useCanvasSync } from '../hooks/useCanvasSync.js'
import { BrowserLocalBackend } from '../lib/browser-local-backend.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { useMemo } from 'react'

interface BrowserLocalCanvasPageProps {
  store: BrowserLocalStore
}

export function BrowserLocalCanvasPage({ store }: BrowserLocalCanvasPageProps) {
  const { snapshot, persistence, cleanupCompleted, cleanupError, triggerCleanup, startFresh } =
    useBrowserLocalCanvasController(store)

  const pageState = derivePageState({ snapshot, persistence, cleanupCompleted })

  // Stable backend instance keyed on the canvas id from the loaded snapshot.
  // useMemo avoids re-connecting on re-renders when id is unchanged.
  const canvasId = pageState.kind === 'editing' ? pageState.snapshot.id : null
  const backend = useMemo(
    () => (canvasId != null ? new BrowserLocalBackend(canvasId) : null),
    // Re-create backend only when canvasId changes; a null id means not-yet-loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasId],
  )

  const { setExcalidrawAPI, onChange } = useCanvasSync(
    // Pass a no-op backend when not yet loaded; the hook will reconnect when a real one arrives.
    backend ?? new BrowserLocalBackend('__placeholder__'),
  )

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
    return (
      <div data-testid="cleanup-completed">
        <p>Canvas removed.</p>
        <button type="button" onClick={() => void startFresh()}>
          Start fresh
        </button>
      </div>
    )
  }

  if (pageState.kind === 'loading') {
    return (
      <div role="status" aria-live="polite">
        Loading…
      </div>
    )
  }

  // Map the persistence state machine to user-facing copy. `degraded` carries its own
  // message; the other states are not shown as raw enum tokens.
  const status = pageState.persistence
  const persistenceLabel =
    status.kind === 'saved'
      ? 'Saved'
      : status.kind === 'saving'
        ? 'Saving…'
        : status.kind === 'pending'
          ? 'Unsaved changes'
          : status.message

  return (
    <main>
      <header>
        <h1>{pageState.snapshot.name}</h1>
        <span>{persistenceLabel}</span>
        {cleanupError && (
          <div role="alert" aria-live="assertive">
            {cleanupError}
          </div>
        )}
        <button type="button" onClick={() => void triggerCleanup()} aria-label="Delete canvas">
          Delete
        </button>
      </header>
      <div data-testid="excalidraw-container" style={{ height: '100%', width: '100%' }}>
        <Excalidraw excalidrawAPI={setExcalidrawAPI} onChange={onChange} />
      </div>
    </main>
  )
}
