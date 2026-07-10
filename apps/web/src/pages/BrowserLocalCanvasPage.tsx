import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog.js'
import { CanvasTitle } from '../components/canvas-title/CanvasTitle.js'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import { useCanvasSync } from '../hooks/useCanvasSync.js'
import { BrowserLocalBackend } from '../lib/browser-local-backend.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { BROWSER_LOCAL_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { derivePageState } from './browser-local-page-state.js'
import {
  type BrowserLocalPersistenceState,
  type LoroStoreLike,
  useBrowserLocalCanvasController,
} from './use-browser-local-canvas-controller.js'

interface BrowserLocalCanvasPageProps {
  store: BrowserLocalStore
  // Injectable so tests can avoid the real LoroStore's IndexedDB dependency
  // (jsdom does not implement IndexedDB); production callers rely on the
  // controller hook's own default.
  loro?: LoroStoreLike
  // Defaults to browser-local so existing callers/tests keep working
  // unedited; App.tsx passes the resolved ProviderState's capabilities.
  capabilities?: WhiteboardCapabilities
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

export function BrowserLocalCanvasPage({
  store,
  loro,
  capabilities = BROWSER_LOCAL_CAPABILITIES,
}: BrowserLocalCanvasPageProps) {
  const {
    snapshot,
    persistence,
    cleanupCompleted,
    cleanupError,
    triggerCleanup,
    startFresh,
    renameCanvas,
    listCanvases,
    createCanvas,
    switchCanvas,
  } = useBrowserLocalCanvasController(store, loro)

  const pageState = derivePageState({ snapshot, persistence, cleanupCompleted })

  // Enumeration is a Promise, not reactive state — refresh whenever the
  // current canvas identity or its own updatedAt changes (covers switch,
  // create-then-switch, and edits to the current row reflecting in the list).
  // The generation guard drops a stale resolution that would otherwise
  // clobber a newer refresh triggered by a fast switch.
  const [canvases, setCanvases] = useState<CanvasSnapshot[]>([])
  // Surfaces a failed "New canvas" click — mirrors cleanupError so a create
  // failure is visible instead of leaving the button a silent no-op.
  const [createError, setCreateError] = useState<string | null>(null)
  // Guards against rapid repeated "New canvas" clicks: without it, concurrent
  // createCanvas() calls before the first resolves would mint orphaned rows.
  const [isCreatingCanvas, setIsCreatingCanvas] = useState(false)
  const listGenerationRef = useRef(0)
  // Stable canvas id from the loaded snapshot; null while not yet loaded.
  const canvasId = pageState.kind === 'editing' ? pageState.snapshot.id : null
  const currentUpdatedAt = pageState.kind === 'editing' ? pageState.snapshot.updatedAt : null
  useEffect(() => {
    if (canvasId === null) return
    const generation = ++listGenerationRef.current
    listCanvases()
      .then((list) => {
        if (generation !== listGenerationRef.current) return
        setCanvases(list)
      })
      .catch((err: unknown) => {
        // A stale/failed list refresh must not surface as an unhandled
        // rejection; the switcher just keeps showing its last-known list.
        console.error('listCanvases failed', err)
      })
  }, [canvasId, currentUpdatedAt, listCanvases])

  // Clear a stale "New canvas" failure once the active canvas changes, so the
  // error banner doesn't linger after the user has moved on.
  useEffect(() => {
    setCreateError(null)
  }, [canvasId])

  // Stable backend instance keyed on the canvas id. useMemo avoids
  // re-connecting on re-renders when id is unchanged.
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

  // The option list refreshes asynchronously (see the effect above) while the
  // selected id changes synchronously on switch/create. Synthesize a
  // fallback option for the gap between those two so the controlled
  // <select>'s value always matches one of its own options.
  const switcherOptions =
    pageState.kind === 'editing' && !canvases.some((c) => c.id === pageState.snapshot.id)
      ? [...canvases, pageState.snapshot]
      : canvases

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
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-2">
        {/* Visually-hidden heading landmark: the editable control below is the
            visible title, but the page keeps a real <h1> for accessibility trees. */}
        <h1 className="sr-only">{pageState.snapshot.name}</h1>
        {/* Key by canvas id so switching canvases remounts the title editor and
            reseeds its draft from the new canvas's name. CanvasTitle deliberately
            does not resync its draft from a changed `value` (that would clobber
            in-progress typing during async load), so without this key the field
            would keep showing the previous canvas's name after a switch. */}
        <CanvasTitle
          key={pageState.snapshot.id}
          value={pageState.snapshot.name}
          onRename={renameCanvas}
        />
        <span className="text-xs text-muted-foreground">
          {persistenceLabel(pageState.persistence)}
        </span>
        {cleanupError && (
          <div role="alert" aria-live="assertive" className="text-xs text-destructive">
            {cleanupError}
          </div>
        )}
        {createError && (
          <div role="alert" aria-live="assertive" className="text-xs text-destructive">
            {createError}
          </div>
        )}
        <select
          aria-label="Canvases"
          value={pageState.snapshot.id}
          disabled={isCreatingCanvas}
          onChange={(event) => {
            const id = event.target.value
            if (id !== pageState.snapshot.id) void switchCanvas(id)
          }}
          className="min-w-0 max-w-40 truncate rounded-md border bg-background px-2 py-1 text-xs"
        >
          {switcherOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={isCreatingCanvas}
          onClick={() => {
            setCreateError(null)
            setIsCreatingCanvas(true)
            createCanvas()
              .then((created) => switchCanvas(created.id))
              .catch(() => {
                setCreateError('Could not create a new canvas. Please try again.')
              })
              .finally(() => setIsCreatingCanvas(false))
          }}
          className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          New canvas
        </button>
        {/* Daemon-only feature teasers: Stage 2 will move these into real
            enabled controls once the daemon UI is ported. flex-wrap on the
            header keeps them from forcing horizontal scroll at narrow
            viewports. */}
        <div className="flex flex-wrap items-center gap-2">
          <CapabilityTeaser label="Version history" enabled={capabilities.versions} />
          <CapabilityTeaser label="Workspaces" enabled={capabilities.workspaces} />
          <CapabilityTeaser label="Branches" enabled={capabilities.branches} />
          <CapabilityTeaser label="Merge" enabled={capabilities.merge} />
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              aria-label="Delete canvas"
              className="ml-auto rounded-md border px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              Delete
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this canvas?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the canvas and its drawing data from this browser. This
                action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => void triggerCleanup()}
                className="bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </header>
      <div data-testid="excalidraw-container" className="min-h-0 flex-1">
        <Excalidraw excalidrawAPI={setExcalidrawAPI} onChange={onChange} />
      </div>
    </main>
  )
}
