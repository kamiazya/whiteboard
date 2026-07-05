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
    // h-dvh makes the page own its viewport height: without it the flex chain
    // has no sized ancestor and the editor area collapses to 0px.
    <main className="flex h-dvh w-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-2">
        <h1 className="truncate text-sm font-semibold">{pageState.snapshot.name}</h1>
        <span className="text-xs text-muted-foreground">{persistenceLabel}</span>
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
