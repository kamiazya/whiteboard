import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { useMemo } from 'react'
import { CanvasTitle } from '../components/canvas-title/CanvasTitle.js'
import { useCanvasSync } from '../hooks/useCanvasSync.js'
import { BrowserLocalBackend } from '../lib/browser-local-backend.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { derivePageState } from './browser-local-page-state.js'
import {
  type BrowserLocalPersistenceState,
  useBrowserLocalCanvasController,
} from './use-browser-local-canvas-controller.js'

interface BrowserLocalCanvasPageProps {
  store: BrowserLocalStore
}

// Map the persistence state machine to user-facing copy. `degraded` carries its
// own message; the other states are not shown as raw enum tokens.
function persistenceLabel(status: BrowserLocalPersistenceState): string {
  switch (status.kind) {
    case 'saved':
      return 'Saved'
    case 'saving':
      return 'Saving…'
    case 'pending':
      return 'Unsaved changes'
    case 'degraded':
      return status.message
  }
}

export function BrowserLocalCanvasPage({ store }: BrowserLocalCanvasPageProps) {
  const {
    snapshot,
    persistence,
    cleanupCompleted,
    cleanupError,
    triggerCleanup,
    startFresh,
    renameCanvas,
  } = useBrowserLocalCanvasController(store)

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

  // useCanvasSync tolerates a null backend (idle, no writes) and reconnects
  // whenever the backend identity changes, so the not-yet-loaded state is
  // represented as null instead of a throwaway placeholder canvas id.
  const { setExcalidrawAPI, onChange } = useCanvasSync(backend)

  if (pageState.kind === 'load-degraded') {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <p className="max-w-md text-sm text-destructive">{pageState.message}</p>
        <button
          type="button"
          onClick={() => void startFresh()}
          className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
        >
          Start fresh
        </button>
      </div>
    )
  }

  if (pageState.kind === 'cleanup-completed') {
    return (
      <div
        data-testid="cleanup-completed"
        className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <p className="text-sm text-muted-foreground">Canvas removed.</p>
        <button
          type="button"
          onClick={() => void startFresh()}
          className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
        >
          Start fresh
        </button>
      </div>
    )
  }

  if (pageState.kind === 'loading') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-dvh items-center justify-center text-sm text-muted-foreground"
      >
        Loading…
      </div>
    )
  }

  return (
    // h-dvh makes the page own its viewport height: without it the flex chain
    // has no sized ancestor and the editor area collapses to 0px.
    <main className="flex h-dvh w-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-2">
        {/* Visually-hidden heading landmark: the editable control below is the
            visible title, but the page keeps a real <h1> for accessibility trees. */}
        <h1 className="sr-only">{pageState.snapshot.name}</h1>
        <CanvasTitle value={pageState.snapshot.name} onRename={renameCanvas} />
        <span className="text-xs text-muted-foreground">
          {persistenceLabel(pageState.persistence)}
        </span>
        {cleanupError && (
          <div role="alert" aria-live="assertive" className="text-xs text-destructive">
            {cleanupError}
          </div>
        )}
        <button
          type="button"
          onClick={() => void triggerCleanup()}
          aria-label="Delete canvas"
          className="ml-auto rounded-md border px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          Delete
        </button>
      </header>
      <div data-testid="excalidraw-container" className="min-h-0 flex-1">
        <Excalidraw excalidrawAPI={setExcalidrawAPI} onChange={onChange} />
      </div>
    </main>
  )
}
