import { serializeSpatial } from '@kamiazya/whiteboard-canvas-codec'
import type { CanvasCoreMeta } from '@kamiazya/whiteboard-canvas-model'
import { isImageRef } from '@kamiazya/whiteboard-canvas-model'
import { LoroSyncPlugin } from 'loro-codemirror'
import { Braces, Copy, Download, EllipsisVertical, Minimize2, Trash2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CanvasPageSkeleton } from '../components/CanvasPageSkeleton.js'
import { CanvasProperties } from '../components/canvas-properties/CanvasProperties.js'
import { ConnectionStatus } from '../components/connection/ConnectionStatus.js'
import { HistoryCluster } from '../components/history-cluster/HistoryCluster.js'
import { createSnapshotAliasResolver } from '../components/markdown-editor/alias-resolver.js'
import { MarkdownEditor } from '../components/markdown-editor/MarkdownEditor.js'
import { SaveStatusChip } from '../components/SaveStatusChip.js'
import { CanvasDisplaySettings } from '../components/spatial-editor/CanvasDisplaySettings.js'
import { SpatialEditor } from '../components/spatial-editor/index.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js'
import { Button } from '../components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.js'
import { sanitizeExportFilenameBase } from '../components/workspace-top-bar/export-filename.js'
import { useSceneExport } from '../components/workspace-top-bar/useSceneExport.js'
import { useCanvasFileSeams } from '../hooks/use-canvas-file-seams.js'
import { useMarkdownEmbedContent } from '../hooks/use-markdown-embed-content.js'
import { useCanvasSync } from '../hooks/useCanvasSync.js'
import { useFavicon } from '../hooks/useFavicon.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import { browserLocalCanvasPath, parseBrowserLocalRoute } from '../lib/app-routes.js'
import { BrowserLocalBackend } from '../lib/browser-local-backend.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { BROWSER_LOCAL_FILE_ADAPTER } from '../lib/canvas-embed-content.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import { browserLocalFaviconStatus, type FaviconStyle, resolveRectColor } from '../lib/favicon.js'
import { readLastTool, resolveInitialTool } from '../lib/initial-tool.js'
import { ensurePersistentStorage } from '../lib/persistent-storage.js'
import { BROWSER_LOCAL_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { cn } from '../lib/utils.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { derivePageState } from './browser-local-page-state.js'
import {
  type LoroStoreLike,
  useBrowserLocalCanvasController,
} from './use-browser-local-canvas-controller.js'
import { useMarkdownCanvasDoc } from './use-markdown-canvas-doc.js'

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
// Kick the fetch at page-module evaluation (this module is itself a lazy
// route chunk, so this is a parallel prefetch, not an entry-chunk cost):
// the merged row now carries the title field and canvas operations, which
// used to render eagerly and must not wait for a render-time chunk fetch.
const workspaceTopBarImport = import('../components/WorkspaceTopBar.js')
const WorkspaceTopBar = lazy(() => workspaceTopBarImport)

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

/**
 * The core meta to show when a canvas has none stored yet — every canvas
 * that predates the facet bar, which is all of them.
 *
 * `title` is seeded from the canvas NAME rather than left blank: the two are
 * one concept, so a canvas already called "Diagram A" must show that as its
 * title, not an empty box the user has to retype. `untitled` is the list's
 * placeholder for an unnamed canvas, so it stays a placeholder here instead
 * of becoming a real stored title on the first unrelated edit.
 */
function fallbackCoreMeta(kind: CanvasSnapshot['kind'], name: string | null): CanvasCoreMeta {
  const title = name && name !== 'untitled' ? name : undefined
  return { type: kind, ...(title ? { title } : {}) }
}

export function BrowserLocalCanvasPage({
  store,
  loro,
  capabilities = BROWSER_LOCAL_CAPABILITIES,
  initialCanvasId,
}: BrowserLocalCanvasPageProps) {
  const {
    loro: resolvedLoro,
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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const canvasOpsButtonRef = useRef<HTMLButtonElement | null>(null)
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
  const { resolvedTheme } = useThemeMode()

  // Fullscreen can also be left with Escape or the browser's own chrome, so
  // the button's label follows the DOCUMENT rather than our own click.
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    // Boolean(): jsdom leaves fullscreenElement undefined rather than null,
    // and `undefined !== null` read as "in fullscreen" on first mount there.
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const pageState = derivePageState({ snapshot, persistence, cleanupCompleted })

  // Enumeration is a Promise, not reactive state — refresh whenever the
  // current canvas identity or its own updatedAt changes (covers switch,
  // create-then-switch, and edits to the current row reflecting in the list).
  // The generation guard drops a stale resolution that would otherwise
  // clobber a newer refresh triggered by a fast switch.
  const [canvases, setCanvases] = useState<CanvasSnapshot[]>([])
  const listGenerationRef = useRef(0)
  // A ref that matches no live canvas id points at a deleted canvas: the
  // editor renders a quiet "Missing reference" and hides the follow
  // affordances instead of navigating to a dead route. Image refs live in
  // the file store, not this list; undefined while the list has not loaded
  // keeps everything ordinary.
  const missingFileRef = useMemo(() => {
    if (canvases.length === 0) return undefined
    const known = new Set(canvases.map((entry) => entry.id))
    return (ref: string) => !isImageRef(ref) && !known.has(ref)
  }, [canvases])
  // Fullscreen target for WorkspaceTopBar's onToggleFullscreen; the whole page
  // (editor + chrome), not just the Excalidraw canvas.
  const mainRef = useRef<HTMLElement | null>(null)
  // Stable canvas id from the loaded snapshot; null while not yet loaded.
  const canvasId = pageState.kind === 'editing' ? pageState.snapshot.id : null
  const canvasName = pageState.kind === 'editing' ? pageState.snapshot.name : null
  const canvasKind = pageState.kind === 'editing' ? pageState.snapshot.kind : 'spatial'
  const markdownDoc = useMarkdownCanvasDoc(resolvedLoro, canvasId, canvasKind === 'markdown')
  // Binds CodeMirror straight to the document's 'body' text container:
  // edits land in the CRDT with real deltas (not the wholesale replace
  // setBody does), and an external change moves the local caret exactly.
  // The hook's doc subscription keeps body state and the save schedule in
  // step with the binding's commits, so onChange has nothing left to do.
  const markdownBinding = useMemo(
    () =>
      markdownDoc.doc === null
        ? undefined
        : [LoroSyncPlugin(markdownDoc.doc, (d) => d.getText('body'))],
    [markdownDoc.doc],
  )
  const noopChange = useCallback(() => {}, [])
  const currentUpdatedAt = pageState.kind === 'editing' ? pageState.snapshot.updatedAt : null

  // [[Name]] resolution for the markdown preview: display names from the
  // same snapshot list the switcher shows, so a link resolves exactly when
  // the author can see one unambiguous canvas by that name.
  const resolveAlias = useMemo(() => createSnapshotAliasResolver(canvases), [canvases])
  // ![[embed]] bodies, pre-fetched so the layout's sync seam has content.
  const resolveEmbed = useMarkdownEmbedContent({
    body: canvasKind === 'markdown' ? (markdownDoc.body ?? '') : '',
    resolveAlias,
  })

  // Canvas id -> URL: once a canvas has loaded, the address bar reflects it
  // (bookmarkable/shareable, matching the daemon side's
  // /canvas/:workspaceId/:slug contract). This page only mounts on
  // /local/:canvasId (App routes '/' to the list), so on a normal open the
  // first run is a no-op — the URL already matches. The first-sync REPLACE
  // exists for the stale-deep-link case: a bookmarked id that no longer
  // exists falls back to the default canvas, and repairing the URL with a
  // push would leave the dead link as a history entry behind it. Every
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
    void switchCanvas(requestedId).then((switched) => {
      // A stale deep link (deleted/unknown canvas) is a recoverable miss:
      // keep the loaded canvas and repair the address bar instead of
      // leaving a URL that names nothing.
      if (!switched) navigate(browserLocalCanvasPath(canvasId), { replace: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // re-connecting on re-renders when id is unchanged. A markdown canvas
  // gets NO backend: the spatial sync layer persists its own LoroDoc to
  // the same store id, and two independent docs for one id are last-writer-
  // wins — the sync layer's body-less doc would clobber the markdown body
  // written by use-markdown-body.
  const backend = useMemo(
    () =>
      canvasId != null && canvasKind !== 'markdown' ? new BrowserLocalBackend(canvasId) : null,
    // Re-create backend only when canvasId/kind changes; a null id means not-yet-loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasId, canvasKind],
  )

  // useCanvasSync tolerates a null backend (idle, no writes) and reconnects
  // whenever the backend identity changes, so the not-yet-loaded state is
  // represented as null instead of a throwaway placeholder canvas id.
  const {
    canvas,
    loaded: canvasLoaded,
    onChange,
    externalVersion,
    exportScene,
    undo,
    redo,
    canUndo,
    canRedo,
    lockedNodeIds,
    setNodeLock,
    lockedEdgeIds,
    setEdgeLock,
    coreFacets,
    setCoreFacets,
  } = useCanvasSync(backend)

  // Export rides the canvas row's operations kebab on this page (the top
  // bar keeps its export only in daemon mode, which has no canvas row).
  const canvasOpsFilenameBase = sanitizeExportFilenameBase(canvasName ?? 'canvas')
  const { exportError, handleExport } = useSceneExport({
    onExport: exportScene,
    filenameBase: canvasOpsFilenameBase,
    log,
  })

  // The seams themselves are backend-agnostic (see use-canvas-file-seams.ts);
  // this page only supplies the browser-local binding and the staleness
  // stamps that make an edit made elsewhere show up on the next refresh.
  const fileSeams = useCanvasFileSeams({
    canvas,
    adapter: BROWSER_LOCAL_FILE_ADAPTER,
    stampOf: useMemo(
      () => new Map(canvases.map((entry) => [entry.id, entry.updatedAt])),
      [canvases],
    ),
  })

  const commands = useWhiteboardCommands({
    provider: { kind: 'browser-local', capabilities },
    canvas: canvasId !== null ? { canvasId, name: canvasName ?? '' } : null,
  })

  // Read once at mount: the routed /settings page is the only place this
  // toggles, and navigating there and back remounts this page (a route
  // change), which re-reads the store fresh — no in-mount reactivity needed.
  const webMcpEnabled = settingsStore.load().capabilities.webMcpEnabled !== false
  useBrowserToolRegistry(commands, canvasId, webMcpEnabled)

  // Canvas data lives in IndexedDB; without an explicit persistence grant
  // the browser may evict it under storage pressure. Fire-and-forget — the
  // grant state is queryable from Settings.
  useEffect(() => {
    void ensurePersistentStorage()
  }, [])

  // Launcher shortcut (manifest `shortcuts`): /?new=canvas creates a fresh
  // canvas once, then strips the param so a reload doesn't create another.
  const shortcutHandledRef = useRef(false)
  useEffect(() => {
    if (shortcutHandledRef.current) return
    shortcutHandledRef.current = true
    const params = new URLSearchParams(window.location.search)
    if (params.get('new') !== 'canvas') return
    params.delete('new')
    const rest = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (rest ? `?${rest}` : ''),
    )
    // Fire-and-forget: the failure path already rolls back inside
    // createCanvas, so the shortcut degrades to a plain load.
    createCanvas().catch((err) => {
      log.error('launcher shortcut create failed', err)
    })
  }, [createCanvas])

  // Tab favicon: persistence state as the status dot (degraded reads as
  // offline — data is at risk either way), scene content as the minimap.
  // Read once at mount for the same remount-re-reads reason as webMcpEnabled
  // above — the style picker now lives on the routed /settings page.
  const faviconStyle: FaviconStyle = settingsStore.load().appearance?.faviconStyle ?? 'minimap'
  useFavicon({
    style: faviconStyle,
    status: browserLocalFaviconStatus(persistence.kind),
    rects: useMemo(
      () =>
        canvas.nodes.map((n) => ({
          x: n.x,
          y: n.y,
          w: n.width,
          h: n.height,
          color: resolveRectColor(n.color),
        })),
      [canvas.nodes],
    ),
  })

  // The option list refreshes asynchronously (see the effect above) while the
  // selected id changes synchronously on switch/create. Synthesize a
  // fallback option for the gap between those two so the controlled
  // <select>'s value always matches one of its own options.
  //
  // The open canvas's own row is always taken from the loaded snapshot rather
  // than from the list: the list read races the save that a rename queues, and
  // a read that resolves first pins the pre-rename name with nothing left to
  // schedule another refresh. The snapshot is this canvas's live truth; the
  // list is only the copy the switcher reads for the OTHER canvases.
  const switcherOptions =
    pageState.kind === 'editing'
      ? canvases.some((c) => c.id === pageState.snapshot.id)
        ? canvases.map((c) => (c.id === pageState.snapshot.id ? pageState.snapshot : c))
        : [...canvases, pageState.snapshot]
      : canvases

  if (pageState.kind === 'load-degraded') {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
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
        className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
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
    return <CanvasPageSkeleton label="Loading canvas" />
  }

  // Whole-document operations live behind a kebab: duplicate and delete
  // are rare actions, and rare + destructive earns a menu (with words)
  // over two always-visible icon buttons. One JSX value shared by both
  // canvas-kind branches so the two rows cannot drift apart.
  const canvasRowActions = (
    <>
      {cleanupError && (
        <div role="alert" aria-live="assertive" className="text-destructive text-xs">
          {cleanupError}
        </div>
      )}
      {duplicateError && (
        <div role="alert" aria-live="assertive" className="text-destructive text-xs">
          {duplicateError}
        </div>
      )}
      {exportError && (
        <div role="alert" aria-live="assertive" className="text-destructive text-xs">
          {exportError}
        </div>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={canvasOpsButtonRef}
                type="button"
                aria-label="More actions"
                variant="ghost"
                size="sm"
                className="size-7 p-0"
              >
                <EllipsisVertical aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void handleExport('png')}>
            <Download aria-hidden="true" className="size-3.5" />
            Export as PNG
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleExport('svg')}>
            <Download aria-hidden="true" className="size-3.5" />
            Export as SVG
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              // Text on the clipboard survives any chat/paste channel intact,
              // which a binary download cannot — the phone-friendly way to
              // hand the exact canvas (coordinates included) to a debugger.
              void navigator.clipboard
                ?.writeText(serializeSpatial(canvas, 'extended'))
                .catch(() => {})
            }}
          >
            <Braces aria-hidden="true" className="size-3.5" />
            Copy as JSON Canvas
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isDuplicating} onSelect={() => void handleDuplicate()}>
            <Copy aria-hidden="true" className="size-3.5" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={() => setConfirmDelete(true)}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent
          // The menu item that opened this dialog unmounted with the menu;
          // default close-focus would fall to <body>, so hand it to the kebab.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            canvasOpsButtonRef.current?.focus()
          }}
        >
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
    </>
  )

  // The merged header row's flexible middle: canvas identity (title, core
  // facets, display settings) lives in the SAME row as workspace context —
  // the second chrome strip is gone. Kind decides the exact segment.
  const canvasTitleSlot =
    canvasKind === 'markdown' ? (
      markdownDoc.body !== null && markdownDoc.coreMeta !== null ? (
        <CanvasProperties
          inline
          key={canvasId ?? 'no-canvas'}
          status={<SaveStatusChip state={pageState.persistence} />}
          actions={canvasRowActions}
          meta={markdownDoc.coreMeta ?? fallbackCoreMeta(canvasKind, canvasName)}
          onChange={(next) => {
            markdownDoc.setCoreMeta(next)
            // title and the canvas name are ONE concept: the facet is the
            // document's own truth, the snapshot row is the copy the canvas
            // list reads without loading every document. `renameCanvas`
            // normalises a cleared title to 'untitled', which is exactly
            // what an absent facet should list as.
            if (next.title !== markdownDoc.coreMeta?.title) {
              void renameCanvas(next.title ?? '').catch(() => {
                // Surfaced through persistence state; the facet write is
                // independent and has already landed in the document.
              })
            }
          }}
        />
      ) : null
    ) : (
      <CanvasProperties
        inline
        // A facet is OKF frontmatter and this branch is the SPATIAL canvas,
        // which has none to hold one (ADR-0009 decision 3) — wb_facet_set
        // refuses to write them here, so the editor does not offer them.
        showFacets={false}
        key={canvasId ?? 'no-canvas'}
        status={<SaveStatusChip state={pageState.persistence} />}
        settings={<CanvasDisplaySettings canvas={canvas} onChange={onChange} />}
        actions={canvasRowActions}
        meta={coreFacets ?? fallbackCoreMeta(canvasKind, canvasName)}
        onChange={(next) => {
          setCoreFacets(next)
          if (next.title !== coreFacets?.title) {
            void renameCanvas(next.title ?? '').catch(() => {
              // Surfaced through persistence state; the facet write is
              // independent and has already landed in the document.
            })
          }
        }}
      />
    )

  return (
    // Two-row grid shell (h-dvh makes the page own its viewport height):
    // every header-shaped row stacks inside the auto row, and the editor
    // owns minmax(0,1fr) — however many rows appear or however tall they
    // wrap, the editor row is always exactly the remaining viewport height.
    // `bg-background` on the FULLSCREEN TARGET, not just on `body`: going
    // fullscreen promotes this element to the top layer, where the body's
    // background no longer shows. Anything this element does not paint itself
    // falls through to the browser's default black backdrop — which turned
    // the canvas area black under a light theme.
    <main
      ref={mainRef}
      className="relative grid h-full w-full grid-rows-[auto_minmax(0,1fr)] bg-background"
    >
      <div className="min-w-0">
        {/* Visually-hidden heading landmark: WorkspaceTopBar's canvas switcher
          is the visible title control, but the page keeps a real <h1> for
          accessibility trees. */}
        <h1 className="sr-only">{pageState.snapshot.name}</h1>
        {/* Fullscreen means the CANVAS, maximised: the whole top-bar row —
            switcher, rename, menus — steps aside. The floating control below
            replaces its exit path, Escape still works natively, and the dock
            stays because editing is what the extra space is FOR. */}
        {!isFullscreen && (
          <Suspense
            fallback={
              <div className={cn(TOP_BAR_FALLBACK_HEIGHT, 'shrink-0 border-b bg-background')} />
            }
          >
            <WorkspaceTopBar
              titleSlot={canvasTitleSlot}
              statusSlot={
                <ConnectionStatus state="local">
                  <p className="text-muted-foreground">
                    Connect a local daemon (MCP) to unlock version history, workspaces, variations,
                    and combining changes
                  </p>
                  <Suspense fallback={null}>
                    <DaemonDetectedBanner
                      settingsStore={settingsStore}
                      fetch={window.fetch.bind(window)}
                    />
                  </Suspense>
                </ConnectionStatus>
              }
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
              onCreateMarkdownCanvas={async () => {
                const created = await createCanvas(undefined, 'markdown')
                await switchCanvas(created.id)
              }}
              isFullscreen={isFullscreen}
              onToggleFullscreen={() => {
                // Entering hides this whole bar; the floating exit control and
                // native Escape are the ways back out.
                if (document.fullscreenElement) void document.exitFullscreen()
                else void mainRef.current?.requestFullscreen()
              }}
              capabilities={{
                versions: capabilities.versions,
                branches: capabilities.branches,
                merge: capabilities.merge,
              }}
            />
          </Suspense>
        )}
      </div>
      {/* The snapshot's kind picks the editor: markdown canvases open the
          markdown editor (body and OKF core facets persisted as containers
          of one Loro document — see use-markdown-canvas-doc.ts), everything
          else the spatial editor. */}
      {isFullscreen && (
        <button
          type="button"
          aria-label="Exit fullscreen"
          onClick={() => void document.exitFullscreen()}
          className="absolute top-3 right-3 z-20 rounded-md border bg-background/80 p-2 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-foreground"
        >
          <Minimize2 aria-hidden="true" className="size-4" />
        </button>
      )}
      <div data-testid="spatial-editor-container" className="relative h-full min-h-0">
        {canvasKind === 'markdown' ? (
          markdownDoc.body !== null &&
          markdownDoc.coreMeta !== null && (
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1">
                <MarkdownEditor
                  key={canvasId ?? 'no-canvas'}
                  value={markdownDoc.body}
                  onChange={markdownBinding === undefined ? markdownDoc.setBody : noopChange}
                  sourceExtensions={markdownBinding}
                  autoFocus
                  className="h-full"
                  theme={resolvedTheme}
                  meta={markdownDoc.coreMeta}
                  resolveAlias={resolveAlias}
                  onOpenCanvas={(id) => navigate(browserLocalCanvasPath(id))}
                  resolveEmbed={resolveEmbed}
                />
              </div>
            </div>
          )
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="relative min-h-0 flex-1">
              {/* Keyed on canvas identity: the editor's pan/zoom, in-flight
                  gesture and open text editor all describe ONE canvas, and
                  `SpatialCanvas` carries no id for the editor to notice a
                  switch by. Without the key, switching canvases silently
                  inherits the previous canvas's viewport. (The markdown
                  branch keys for the same reason.) */}
              <SpatialEditor
                key={canvasId ?? 'no-canvas'}
                // Decided from the canvas's own shape, but only once its
                // document has loaded — at mount every canvas still looks
                // empty.
                initialTool={
                  canvasLoaded
                    ? resolveInitialTool({
                        isEmpty: canvas.nodes.length === 0,
                        lastTool: readLastTool(),
                      })
                    : undefined
                }
                canvas={canvas}
                onChange={onChange}
                externalVersion={externalVersion}
                theme={resolvedTheme}
                // File-node reference = browser-local canvas id; the current
                // canvas is excluded (a self-reference card is pure noise).
                fileRefOptions={canvases
                  .filter((entry) => entry.id !== canvasId)
                  .map((entry) => ({ file: entry.id, label: entry.name }))}
                onOpenFileRef={(file) => navigate(browserLocalCanvasPath(file))}
                missingFileRef={missingFileRef}
                {...fileSeams}
                lockedNodeIds={lockedNodeIds}
                lockedEdgeIds={lockedEdgeIds}
                onToggleNodeLock={setNodeLock}
                onToggleEdgeLock={setEdgeLock}
                paletteLeading={
                  <HistoryCluster
                    onUndo={() => void undo()}
                    onRedo={() => void redo()}
                    canUndo={canUndo()}
                    canRedo={canRedo()}
                  />
                }
              />
            </div>
          </div>
        )}
        {/* Markdown canvases keep CodeMirror's own history (its keymap
            already handles undo); the history group rides the spatial
            editor's dock via paletteLeading above. */}
      </div>
    </main>
  )
}
