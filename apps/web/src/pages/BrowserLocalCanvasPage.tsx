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
import { getAppLogger } from '../lib/app-logger.js'
import { browserLocalCanvasPath, parseBrowserLocalRoute } from '../lib/app-routes.js'
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

const log = getAppLogger('browser-local-canvas-page')

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
  // This never fights the URL->canvas effect below: that effect only calls
  // switchCanvas when the URL disagrees with the already-loaded canvasId, and
  // by the time navigate() below lands, location.pathname already equals
  // path — so the other effect sees no drift left to act on.
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

  // URL -> canvas id: browser Back/Forward (and any other history navigation)
  // moves location.pathname without any switcher click firing, so this is the
  // only thing that keeps the loaded canvas in sync with the address bar for
  // that direction. Runs in an effect (never during render) so it can't race
  // Excalidraw's own render cycle; switchCanvas's generation guard (see the
  // controller hook) protects against a rapid back-back-back burst landing a
  // stale canvas.
  //
  // lastKnownCanvasIdRef distinguishes the two ways this effect's own
  // dependencies can change: a switcher-driven switchCanvas() updates canvasId
  // before the sibling canvas-id -> URL effect's navigate() call has actually
  // updated `location`, so this effect would otherwise see a stale pathname
  // that still names the PREVIOUS canvas and switch straight back to it. When
  // the URL still names the previously-known canvas id, that's this
  // component's own pending push catching up, not an external navigation —
  // skip it and let the other effect finish the sync.
  const lastKnownCanvasIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (canvasId === null) return
    const requestedId = parseBrowserLocalRoute(location.pathname)?.canvasId
    const lastKnownCanvasId = lastKnownCanvasIdRef.current
    lastKnownCanvasIdRef.current = canvasId
    if (requestedId === undefined || requestedId === canvasId) return
    if (requestedId === lastKnownCanvasId) return
    void switchCanvas(requestedId)
  }, [location.pathname, canvasId, switchCanvas])

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
        log.error('listCanvases failed', err)
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

  // Surfaced when the backend's putFile rejects (IDB write/quota failure),
  // so a failed image upload is never silent — see useCanvasSync's own
  // no-silent-success contract for putFile. Cleared on the next successful
  // upload so a transient failure doesn't stick around forever.
  const [fileUploadError, setFileUploadError] = useState<string | null>(null)

  // This banner is page-level state, not scoped per backend connection, so a
  // failure seen on canvas A would otherwise keep showing after switching to
  // canvas B (which never fired the failure). Reset whenever the loaded
  // canvas identity changes so a stale error never follows the user across
  // canvases.
  useEffect(() => {
    setFileUploadError(null)
  }, [canvasId])

  // useCanvasSync tolerates a null backend (idle, no writes) and reconnects
  // whenever the backend identity changes, so the not-yet-loaded state is
  // represented as null instead of a throwaway placeholder canvas id.
  const { setExcalidrawAPI, onChange, exportScene } = useCanvasSync(backend, {
    onFileUploadFailed: () => {
      setFileUploadError('Could not save an image to this browser. It may not survive a reload.')
    },
    onFileUploadSucceeded: () => setFileUploadError(null),
  })

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
          onExport={exportScene}
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
        {fileUploadError && (
          <div role="alert" aria-live="assertive" className="text-destructive">
            {fileUploadError}
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
