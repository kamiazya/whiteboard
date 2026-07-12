import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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
import { useCanvasSync } from '../hooks/useCanvasSync.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { browserLocalCanvasPath } from '../lib/app-routes.js'
import { BrowserLocalBackend } from '../lib/browser-local-backend.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { BROWSER_LOCAL_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { cn } from '../lib/utils.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { derivePageState } from './browser-local-page-state.js'
import {
  type BrowserLocalPersistenceState,
  type LoroStoreLike,
  useBrowserLocalCanvasController,
} from './use-browser-local-canvas-controller.js'

// React.lazy: DaemonDetectedBanner pulls in daemon-probe.ts + Zod parsing
// that would otherwise ship in the entry chunk, which is already close to
// its gzip budget (apps/web/scripts/smoke-bundle-size.mjs). Deferred load
// keeps first paint unaffected by a feature most sessions never render.
const DaemonDetectedBanner = lazy(() =>
  import('../components/migration/DaemonDetectedBanner.js').then((m) => ({
    default: m.DaemonDetectedBanner,
  })),
)

// WorkspaceTopBar statically imports Radix, lucide, HeaderSaveDot,
// VersionTimeline, HeaderBranchChip, and the Zod-validated
// @kamiazya/whiteboard-mcp/api-contracts client. None of that daemon-mode
// weight is needed for the entry chunk of a page whose local mode never
// exercises those affordances (see App.tsx's equivalent rationale for
// lazy-loading DaemonCanvasPage).
const WorkspaceTopBar = lazy(() => import('../components/WorkspaceTopBar.js'))

// Fixed height so the lazy WorkspaceTopBar chunk resolving after first paint
// causes no layout shift.
const TOP_BAR_FALLBACK_HEIGHT = 'h-12'

interface BrowserLocalCanvasPageProps {
  store: BrowserLocalStore
  // Injectable so tests can avoid the real LoroStore's IndexedDB dependency
  // (jsdom does not implement IndexedDB); production callers rely on the
  // controller hook's own default.
  loro?: LoroStoreLike
  // Defaults to browser-local so existing callers/tests keep working
  // unedited; App.tsx passes the resolved ProviderState's capabilities.
  capabilities?: WhiteboardCapabilities
  // A canvas id requested by the URL at mount (e.g. a bookmarked
  // /local/:canvasId deep link), read once — see
  // useBrowserLocalCanvasController's own contract for the same parameter.
  initialCanvasId?: string
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
  initialCanvasId,
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
    duplicateCanvas,
  } = useBrowserLocalCanvasController(store, loro, initialCanvasId)
  const location = useLocation()
  const navigate = useNavigate()

  // Stable across re-renders so DaemonDetectedBanner's dismissal state isn't
  // re-read from localStorage on every render.
  const [settingsStore] = useState(() => createUserSettingsStore())

  // duplicateCanvas() rejects on failure (see the controller hook) rather
  // than carrying its own error/pending state, so this page owns both: a
  // disable-while-in-flight guard (a second click during the async
  // read-then-write must not start a second copy) and the error surface.
  const [isDuplicating, setIsDuplicating] = useState(false)
  const [duplicateError, setDuplicateError] = useState<string | null>(null)
  const handleDuplicate = async () => {
    if (isDuplicating) return
    setIsDuplicating(true)
    setDuplicateError(null)
    try {
      await duplicateCanvas()
    } catch (err) {
      setDuplicateError(err instanceof Error ? err.message : 'Failed to duplicate canvas.')
    } finally {
      setIsDuplicating(false)
    }
  }

  // Owned locally rather than threaded down from App.tsx: useThemeMode already
  // persists to localStorage and applies the <html class="dark"> toggle
  // itself, so there is no App-level state this page needs to share.
  const { theme, resolvedTheme, setTheme } = useThemeMode()

  const pageState = derivePageState({ snapshot, persistence, cleanupCompleted })

  // Enumeration is a Promise, not reactive state — refresh whenever the
  // current canvas identity or its own updatedAt changes (covers switch,
  // create-then-switch, and edits to the current row reflecting in the list).
  // The generation guard drops a stale resolution that would otherwise
  // clobber a newer refresh triggered by a fast switch.
  const [canvases, setCanvases] = useState<CanvasSnapshot[]>([])
  const listGenerationRef = useRef(0)
  // Fullscreen target for WorkspaceTopBar's onEnterFullscreen; the whole page
  // (editor + chrome), not just the Excalidraw canvas.
  const mainRef = useRef<HTMLElement | null>(null)
  // Stable canvas id from the loaded snapshot; null while not yet loaded.
  const canvasId = pageState.kind === 'editing' ? pageState.snapshot.id : null
  const currentUpdatedAt = pageState.kind === 'editing' ? pageState.snapshot.updatedAt : null

  // Canvas id -> URL: once a canvas has loaded, the address bar reflects it
  // (bookmarkable/shareable, matching the daemon side's
  // /canvas/:workspaceId/:slug contract). The first sync replaces so a
  // plain '/' load doesn't leave an extra history entry behind it; every
  // subsequent switch (via the switcher, or create-then-switch) pushes.
  //
  // Deliberately one-directional (no URL->switchCanvas effect): wiring
  // browser back/forward to re-trigger switchCanvas raced with Excalidraw's
  // own render cycle in practice (an update-during-a-different-component's-
  // render warning, with the location change never reaching this
  // component's next render in time) without a robust fix found in this
  // pass. Landing the one-directional half now still makes every
  // browser-local canvas addressable; the round-trip is a known follow-up.
  const isFirstCanvasUrlSyncRef = useRef(true)
  useEffect(() => {
    if (canvasId === null) return
    const path = browserLocalCanvasPath(canvasId)
    const isFirstSync = isFirstCanvasUrlSyncRef.current
    isFirstCanvasUrlSyncRef.current = false
    if (location.pathname === path) return
    navigate(path, { replace: isFirstSync })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId, navigate])

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
    <main ref={mainRef} className="flex h-dvh w-full flex-col">
      {/* Visually-hidden heading landmark: WorkspaceTopBar's canvas switcher
          is the visible title control, but the page keeps a real <h1> for
          accessibility trees. */}
      <h1 className="sr-only">{pageState.snapshot.name}</h1>
      <Suspense
        fallback={
          <div className={cn(TOP_BAR_FALLBACK_HEIGHT, 'shrink-0 border-b bg-background')} />
        }
      >
        <WorkspaceTopBar
          dataMode="local"
          workspaceId="local"
          slug={pageState.snapshot.id}
          canvases={switcherOptions.map((c) => ({
            slug: c.id,
            name: c.name,
            updatedAt: c.updatedAt,
          }))}
          onNavigateToCanvas={(id) => void switchCanvas(id)}
          onRenameCanvas={renameCanvas}
          onCreateCanvas={async () => {
            const created = await createCanvas()
            await switchCanvas(created.id)
          }}
          theme={theme}
          onToggleTheme={setTheme}
          onEnterFullscreen={() => {
            void mainRef.current?.requestFullscreen()
          }}
          capabilities={{
            versions: capabilities.versions,
            branches: capabilities.branches,
            merge: capabilities.merge,
          }}
        />
      </Suspense>
      {/* Page-specific bits that WorkspaceTopBar has no slot for. A plain
          div, not a second <header>: two sibling <header> landmarks under
          <main> would both register as "banner" in accessibility trees
          since <main> does not scope them the way sectioning content does. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-1 text-xs">
        <span className="text-muted-foreground">{persistenceLabel(pageState.persistence)}</span>
        <Suspense fallback={null}>
          <DaemonDetectedBanner settingsStore={settingsStore} fetch={window.fetch.bind(window)} />
        </Suspense>
        {cleanupError && (
          <div role="alert" aria-live="assertive" className="text-destructive">
            {cleanupError}
          </div>
        )}
        {duplicateError && (
          <div role="alert" aria-live="assertive" className="text-destructive">
            {duplicateError}
          </div>
        )}
        <span className="ml-auto text-muted-foreground">
          Connect a local daemon (MCP) to unlock version history, workspaces, variations, and
          combining changes
        </span>
        <button
          type="button"
          aria-label="Duplicate canvas"
          disabled={isDuplicating}
          onClick={() => void handleDuplicate()}
          className="rounded-md border px-3 py-1 font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        >
          Duplicate
        </button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              aria-label="Delete canvas"
              className="rounded-md border px-3 py-1 font-medium text-destructive transition-colors hover:bg-destructive/10"
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
      </div>
      <div data-testid="excalidraw-container" className="min-h-0 flex-1">
        <Excalidraw excalidrawAPI={setExcalidrawAPI} onChange={onChange} theme={resolvedTheme} />
      </div>
    </main>
  )
}
