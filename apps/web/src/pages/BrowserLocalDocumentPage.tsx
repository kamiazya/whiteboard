import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import { MARKDOWN_BODY_KEY } from '@kamiazya/whiteboard-loro-adapter'
import { isImageRef } from '@kamiazya/whiteboard-model'
import { LoroSyncPlugin } from 'loro-codemirror'
import { Braces, Copy, Download, EllipsisVertical, Minimize2, Trash2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ConnectionStatus } from '../components/connection/ConnectionStatus.js'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { DocumentEditorSurface } from '../components/document-editor/DocumentEditorSurface.js'
import { NodeTextEditorOverlay } from '../components/document-editor/NodeTextEditorOverlay.js'
import { useNodeInEditor } from '../components/document-editor/use-node-in-editor.js'
import { DocumentProperties } from '../components/document-properties/DocumentProperties.js'
import { HistoryCluster } from '../components/history-cluster/HistoryCluster.js'
import { createSnapshotAliasResolver } from '../components/markdown-editor/alias-resolver.js'
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
import { useDocumentFileSeams } from '../hooks/use-document-file-seams.js'
import { useMarkdownEmbedContent } from '../hooks/use-markdown-embed-content.js'
import { useDocumentOutline } from '../hooks/useDocumentOutline.js'
import { useDocumentSync } from '../hooks/useDocumentSync.js'
import { useFavicon } from '../hooks/useFavicon.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import { browserLocalDocumentPath, parseBrowserLocalRoute } from '../lib/app-routes.js'
import { BrowserLocalBackend } from '../lib/browser-local-backend.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import { BROWSER_LOCAL_FILE_ADAPTER } from '../lib/document-embed-content.js'
import { browserLocalFaviconStatus, type FaviconStyle } from '../lib/favicon.js'
import { readLastTool, resolveInitialTool } from '../lib/initial-tool.js'
import { ensurePersistentStorage } from '../lib/persistent-storage.js'
import { BROWSER_LOCAL_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { cn } from '../lib/utils.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { derivePageState } from './browser-local-page-state.js'
import {
  type LoroStoreLike,
  useBrowserLocalDocumentController,
} from './use-browser-local-document-controller.js'
import { useMarkdownDocument } from './use-markdown-document.js'

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
// lazy-loading DaemonDocumentPage).
// Kick the fetch at page-module evaluation (this module is itself a lazy
// route chunk, so this is a parallel prefetch, not an entry-chunk cost):
// the merged row now carries the title field and canvas operations, which
// used to render eagerly and must not wait for a render-time chunk fetch.
const workspaceTopBarImport = import('../components/WorkspaceTopBar.js')
const WorkspaceTopBar = lazy(() => workspaceTopBarImport)

// Fixed height so the lazy WorkspaceTopBar chunk resolving after first paint
// causes no layout shift.
const TOP_BAR_FALLBACK_HEIGHT = 'h-12'

const log = getAppLogger('browser-local-document-page')

interface BrowserLocalDocumentPageProps {
  store: BrowserLocalStore
  // Injectable so tests can avoid the real LoroStore's IndexedDB dependency
  // (jsdom does not implement IndexedDB); production callers rely on the
  // controller hook's own default.
  loro?: LoroStoreLike
  // Defaults to browser-local so existing callers/tests keep working
  // unedited; App.tsx passes the resolved ProviderState's capabilities.
  capabilities?: WhiteboardCapabilities
  // A canvas id requested by the URL at mount (e.g. a bookmarked
  // /local/:documentId deep link), read once — see
  // useBrowserLocalDocumentController's own contract for the same parameter.
  initialDocumentId?: string
}

// Map the persistence state machine to user-facing copy. `degraded` carries its
// own message; the other states are not shown as raw enum tokens.

/**
 * The canvas name as a TITLE. `untitled` is the store's sentinel for an
 * unnamed canvas (`renameDocument` normalises a cleared name to it), so it
 * becomes the empty string here and the title box falls back to its
 * placeholder rather than showing the sentinel as a real name.
 */
function titleOf(name: string | null): string {
  return name === null || name === 'untitled' ? '' : name
}

export function BrowserLocalDocumentPage({
  store,
  loro,
  capabilities = BROWSER_LOCAL_CAPABILITIES,
  initialDocumentId,
}: BrowserLocalDocumentPageProps) {
  const {
    loro: resolvedLoro,
    snapshot,
    persistence,
    cleanupCompleted,
    cleanupError,
    triggerCleanup,
    startFresh,
    renameDocument,
    listDocuments,
    createDocument,
    switchDocument,
    duplicateDocument,
  } = useBrowserLocalDocumentController(store, loro, initialDocumentId)
  const location = useLocation()
  const navigate = useNavigate()

  // Stable across re-renders so DaemonDetectedBanner's dismissal state isn't
  // re-read from localStorage on every render.
  const [settingsStore] = useState(() => createUserSettingsStore())

  // duplicateDocument() rejects on failure (see the controller hook) rather
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
      await duplicateDocument()
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
  const exitFullscreenRef = useRef<HTMLButtonElement | null>(null)
  const wasFullscreenRef = useRef(false)
  // The toggle unmounts the element that was just activated (entering removes
  // the top bar's button, exiting removes the floating one), and a removed
  // focused element drops focus to <body> — a keyboard user would have to
  // tab back from nothing. Hand focus to whichever control replaced it.
  useEffect(() => {
    if (isFullscreen) {
      wasFullscreenRef.current = true
      exitFullscreenRef.current?.focus()
      return
    }
    if (!wasFullscreenRef.current) return
    wasFullscreenRef.current = false
    // The top bar is lazy, so its toggle may land a frame later; retry
    // briefly rather than racing the remount.
    let attempts = 12
    const tryFocus = () => {
      const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
      if (toggle !== null) {
        toggle.focus()
        return
      }
      attempts -= 1
      if (attempts > 0) requestAnimationFrame(tryFocus)
    }
    tryFocus()
  }, [isFullscreen])
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
  const [documents, setDocuments] = useState<DocumentSnapshot[]>([])
  const listGenerationRef = useRef(0)
  // A ref that matches no live canvas id points at a deleted canvas: the
  // editor renders a quiet "Missing reference" and hides the follow
  // affordances instead of navigating to a dead route. Image refs live in
  // the file store, not this list; undefined while the list has not loaded
  // keeps everything ordinary.
  const missingFileRef = useMemo(() => {
    if (documents.length === 0) return undefined
    const known = new Set(documents.map((entry) => entry.documentId))
    return (ref: string) => !isImageRef(ref) && !known.has(ref)
  }, [documents])
  // Fullscreen target for WorkspaceTopBar's onToggleFullscreen; the whole page
  // (editor + chrome), not just the Excalidraw canvas.
  const mainRef = useRef<HTMLElement | null>(null)
  // Stable canvas id from the loaded snapshot; null while not yet loaded.
  const documentId = pageState.kind === 'editing' ? pageState.snapshot.documentId : null
  const documentName = pageState.kind === 'editing' ? pageState.snapshot.name : null
  const documentKind = pageState.kind === 'editing' ? pageState.snapshot.kind : 'spatial'
  const markdownDoc = useMarkdownDocument(resolvedLoro, documentId, documentKind === 'markdown')
  // Binds CodeMirror straight to the document's 'body' text container:
  // edits land in the CRDT with real deltas (not the wholesale replace
  // setBody does), and an external change moves the local caret exactly.
  // The hook's doc subscription keeps body state and the save schedule in
  // step with the binding's commits, so onChange has nothing left to do.
  const markdownBinding = useMemo(
    () =>
      markdownDoc.doc === null
        ? undefined
        : [LoroSyncPlugin(markdownDoc.doc, (d) => d.getText(MARKDOWN_BODY_KEY))],
    [markdownDoc.doc],
  )
  const currentUpdatedAt = pageState.kind === 'editing' ? pageState.snapshot.updatedAt : null

  // [[Name]] resolution for the markdown preview: display names from the
  // same snapshot list the switcher shows, so a link resolves exactly when
  // the author can see one unambiguous canvas by that name.
  // `createSnapshotAliasResolver` takes {id, name}; a stored row now says
  // `documentId`, so the projection is explicit rather than structural.
  const resolveAlias = useMemo(
    () =>
      createSnapshotAliasResolver(
        documents.map((entry) => ({ id: entry.documentId, name: entry.name })),
      ),
    [documents],
  )
  // The list read races the save a rename queues, so this canvas's live
  // truth is its own snapshot and the list is only the copy for the OTHER
  // documents. Both the switcher and the link picker read THIS, or the
  // picker would offer a stale name for the document being edited — or omit
  // it entirely right after it was created.
  const switcherOptions =
    pageState.kind === 'editing'
      ? documents.some((c) => c.documentId === pageState.snapshot.documentId)
        ? documents.map((c) =>
            c.documentId === pageState.snapshot.documentId ? pageState.snapshot : c,
          )
        : [...documents, pageState.snapshot]
      : documents
  // The URL and the file-node reference speak different addresses: a route
  // carries a path (so the hierarchy is visible and it matches the daemon's),
  // while a reference carries the document id (so it survives a move). These
  // two are the only places that convert, and everything else stays in one
  // vocabulary.
  const pathOfDocument = useCallback(
    (id: string) => switcherOptions.find((entry) => entry.documentId === id)?.path ?? null,
    [switcherOptions],
  )
  const documentIdOfPath = useCallback(
    (path: string) => switcherOptions.find((entry) => entry.path === path)?.documentId ?? null,
    [switcherOptions],
  )

  const linkTargets = useMemo(
    () =>
      switcherOptions.map((entry) => ({
        id: entry.documentId,
        name: entry.name,
        kind: entry.kind,
      })),
    [switcherOptions],
  )
  // ![[embed]] bodies, pre-fetched so the layout's sync seam has content.
  const resolveEmbed = useMarkdownEmbedContent({
    body: documentKind === 'markdown' ? (markdownDoc.body ?? '') : '',
    resolveAlias,
  })

  // Canvas id -> URL: once a canvas has loaded, the address bar reflects it
  // (bookmarkable/shareable, matching the daemon side's
  // /document/:workspaceId/:path contract). This page only mounts on
  // /local/:documentId (App routes '/' to the list), so on a normal open the
  // first run is a no-op — the URL already matches. The first-sync REPLACE
  // exists for the stale-deep-link case: a bookmarked id that no longer
  // exists falls back to the default canvas, and repairing the URL with a
  // push would leave the dead link as a history entry behind it. Every
  // subsequent switch (via the switcher, or create-then-switch) pushes.
  //
  // This never fights the URL->canvas effect below: that effect only calls
  // switchDocument when the URL disagrees with the already-loaded documentId, and
  // by the time navigate() below lands, location.pathname already equals
  // path — so the other effect sees no drift left to act on.
  const isFirstCanvasUrlSyncRef = useRef(true)
  useEffect(() => {
    if (documentId === null) return
    const path = browserLocalDocumentPath(documentId)
    const isFirstSync = isFirstCanvasUrlSyncRef.current
    isFirstCanvasUrlSyncRef.current = false
    if (location.pathname === path) return
    navigate(path, { replace: isFirstSync })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, navigate])

  // URL -> canvas id: browser Back/Forward (and any other history navigation)
  // moves location.pathname without any switcher click firing, so this is the
  // only thing that keeps the loaded canvas in sync with the address bar for
  // that direction. Runs in an effect (never during render) so it can't race
  // Excalidraw's own render cycle; switchDocument's generation guard (see the
  // controller hook) protects against a rapid back-back-back burst landing a
  // stale canvas.
  //
  // lastKnownCanvasIdRef distinguishes the two ways this effect's own
  // dependencies can change: a switcher-driven switchDocument() updates documentId
  // before the sibling canvas-id -> URL effect's navigate() call has actually
  // updated `location`, so this effect would otherwise see a stale pathname
  // that still names the PREVIOUS canvas and switch straight back to it. When
  // the URL still names the previously-known canvas id, that's this
  // component's own pending push catching up, not an external navigation —
  // skip it and let the other effect finish the sync.
  const lastKnownCanvasIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (documentId === null) return
    const requestedPath = parseBrowserLocalRoute(location.pathname)?.path
    const requestedId = requestedPath === undefined ? null : documentIdOfPath(requestedPath)
    const lastKnownDocumentId = lastKnownCanvasIdRef.current
    lastKnownCanvasIdRef.current = documentId
    if (requestedId === null || requestedId === documentId) return
    if (requestedId === lastKnownDocumentId) return
    void switchDocument(requestedId).then((switched) => {
      // A stale deep link (deleted/unknown canvas) is a recoverable miss:
      // keep the loaded canvas and repair the address bar instead of
      // leaving a URL that names nothing.
      if (!switched) {
        const here = pathOfDocument(documentId)
        if (here !== null) navigate(browserLocalDocumentPath(here), { replace: true })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, documentId, switchDocument])

  useEffect(() => {
    if (documentId === null) return
    const generation = ++listGenerationRef.current
    listDocuments()
      .then((list) => {
        if (generation !== listGenerationRef.current) return
        setDocuments(list)
      })
      .catch((err: unknown) => {
        // A stale/failed list refresh must not surface as an unhandled
        // rejection; the switcher just keeps showing its last-known list.
        log.error('listDocuments failed', err)
      })
  }, [documentId, currentUpdatedAt, listDocuments])

  // Stable backend instance keyed on the canvas id. useMemo avoids
  // re-connecting on re-renders when id is unchanged. A markdown canvas
  // gets NO backend: the spatial sync layer persists its own LoroDoc to
  // the same store id, and two independent docs for one id are last-writer-
  // wins — the sync layer's body-less doc would clobber the markdown body
  // written by use-markdown-body.
  const backend = useMemo(
    () =>
      documentId != null && documentKind !== 'markdown'
        ? new BrowserLocalBackend(documentId)
        : null,
    // Re-create backend only when documentId/kind changes; a null id means not-yet-loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentId, documentKind],
  )

  // useDocumentSync tolerates a null backend (idle, no writes) and reconnects
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
  } = useDocumentSync(backend)

  const nodeInEditor = useNodeInEditor(canvas, onChange)

  // Export rides the canvas row's operations kebab on this page (the top
  // bar keeps its export only in daemon mode, which has no canvas row).
  const documentOpsFilenameBase = sanitizeExportFilenameBase(documentName ?? 'canvas')
  const { exportError, handleExport } = useSceneExport({
    onExport: exportScene,
    filenameBase: documentOpsFilenameBase,
    log,
  })

  // The seams themselves are backend-agnostic (see use-document-file-seams.ts);
  // this page only supplies the browser-local binding and the staleness
  // stamps that make an edit made elsewhere show up on the next refresh.
  const fileSeams = useDocumentFileSeams({
    canvas,
    adapter: BROWSER_LOCAL_FILE_ADAPTER,
    stampOf: useMemo(
      () => new Map(documents.map((entry) => [entry.documentId, entry.updatedAt])),
      [documents],
    ),
  })

  const commands = useWhiteboardCommands({
    provider: { kind: 'browser-local', capabilities },
    canvas: documentId !== null ? { documentId, name: documentName ?? '' } : null,
  })

  // Read once at mount: the routed /settings page is the only place this
  // toggles, and navigating there and back remounts this page (a route
  // change), which re-reads the store fresh — no in-mount reactivity needed.
  const webMcpEnabled = settingsStore.load().capabilities.webMcpEnabled !== false
  useBrowserToolRegistry(commands, documentId, webMcpEnabled)

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
    // createDocument, so the shortcut degrades to a plain load.
    createDocument().catch((err) => {
      log.error('launcher shortcut create failed', err)
    })
  }, [createDocument])

  // Tab favicon: persistence state as the status dot (degraded reads as
  // offline — data is at risk either way), scene content as the minimap.
  // Read once at mount for the same remount-re-reads reason as webMcpEnabled
  // above — the style picker now lives on the routed /settings page.
  const faviconStyle: FaviconStyle = settingsStore.load().appearance?.faviconStyle ?? 'minimap'
  // One shape for whichever kind this document is — the favicon draws
  // it today, and a tree row's icon draws the same one.
  const documentOutline = useDocumentOutline({
    kind: documentKind,
    canvas: canvas,
    markdownBody: documentKind === 'markdown' ? (markdownDoc.body ?? '') : null,
  })

  useFavicon({
    style: faviconStyle,
    status: browserLocalFaviconStatus(persistence.kind),
    rects: documentOutline,
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
  // list is only the copy the switcher reads for the OTHER documents.

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
    return <DocumentPageSkeleton label="Loading canvas" />
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

  // The name goes to the workspace and NOWHERE else: it is a property of the
  // document's place, not of its content (ADR-0009 decision 2), so the
  // snapshot row is the one copy and the OKF `title` is projected from it on
  // export. Both kinds share this — the same callback for both mount sites
  // below is the point, not a coincidence.
  const onTitleChange = (next: string) => {
    void renameDocument(next).catch(() => {
      // Surfaced through persistence state, which the save chip beside this
      // box already renders.
    })
  }

  // The merged header row's flexible middle: canvas identity (title, core
  // facets, display settings) lives in the SAME row as workspace context —
  // the second chrome strip is gone. Kind decides the exact segment.
  const documentTitleSlot =
    documentKind === 'markdown' ? (
      markdownDoc.body !== null && markdownDoc.coreFacets !== null ? (
        <DocumentProperties
          inline
          key={documentId ?? 'no-canvas'}
          status={<SaveStatusChip state={pageState.persistence} />}
          actions={canvasRowActions}
          title={titleOf(documentName)}
          onTitleChange={onTitleChange}
          facets={markdownDoc.coreFacets}
          onFacetsChange={markdownDoc.setCoreFacets}
        />
      ) : null
    ) : (
      // No facets at all: this branch is the SPATIAL canvas, and a facet is
      // OKF frontmatter that JSON Canvas has nowhere to put (ADR-0009
      // decision 3). It used to pass `showFacets={false}` and keep WRITING
      // them, which is the shape the ADR calls out — the editor hid what the
      // document went on storing.
      <DocumentProperties
        inline
        key={documentId ?? 'no-canvas'}
        status={<SaveStatusChip state={pageState.persistence} />}
        settings={<CanvasDisplaySettings canvas={canvas} onChange={onChange} />}
        actions={canvasRowActions}
        title={titleOf(documentName)}
        onTitleChange={onTitleChange}
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
              // Local mode names documents through its own store, not through
              // the daemon's `/names`, so the identity the bar offers is unused
              // here and `documentName`/`onTitleChange` stay the source.
              titleSlot={() => documentTitleSlot}
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
              path={pageState.snapshot.path}
              documents={switcherOptions.map((c) => ({
                path: c.path,
                name: c.name,
                updatedAt: c.updatedAt,
              }))}
              onNavigateToDocument={(path) => {
                const id = documentIdOfPath(path)
                if (id !== null) void switchDocument(id)
              }}
              onRenameDocument={renameDocument}
              onCreateDocument={async () => {
                const created = await createDocument()
                await switchDocument(created.documentId)
              }}
              onCreateMarkdownCanvas={async () => {
                const created = await createDocument(undefined, 'markdown')
                await switchDocument(created.documentId)
              }}
              isFullscreen={isFullscreen}
              onToggleFullscreen={() => {
                // Entering hides this whole bar; the floating exit control and
                // native Escape are the ways back out. requestFullscreen can
                // REJECT (Permissions-Policy, an iframe without
                // allow="fullscreen", no user activation) — a swallowed
                // rejection is unhandled-rejection noise, so both directions log.
                if (document.fullscreenElement)
                  document.exitFullscreen().catch((err) => log.warn('exitFullscreen failed', err))
                else
                  mainRef.current
                    ?.requestFullscreen()
                    .catch((err) => log.warn('requestFullscreen rejected', err))
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
      {/* The snapshot's kind picks the editor: markdown documents open the
          markdown editor (body and OKF core facets persisted as containers
          of one Loro document — see use-markdown-document.ts), everything
          else the spatial editor. */}
      {isFullscreen && (
        <Button
          ref={exitFullscreenRef}
          variant="outline"
          size="icon"
          aria-label="Exit fullscreen"
          onClick={() =>
            document.exitFullscreen().catch((err) => log.warn('exitFullscreen failed', err))
          }
          className="absolute top-3 right-3 z-20 bg-background/80 text-muted-foreground backdrop-blur hover:text-foreground"
        >
          <Minimize2 aria-hidden="true" className="size-4" />
        </Button>
      )}
      <div data-testid="spatial-editor-container" className="relative h-full min-h-0">
        <DocumentEditorSurface
          kind={documentKind}
          documentKey={documentId ?? 'no-canvas'}
          markdown={
            markdownDoc.coreFacets === null
              ? { body: null, setBody: markdownDoc.setBody }
              : {
                  body: markdownDoc.body,
                  setBody: markdownDoc.setBody,
                  sourceExtensions: markdownBinding,
                  autoFocus: true,
                  theme: resolvedTheme,
                  meta: markdownDoc.coreFacets,
                  title: titleOf(documentName),
                  resolveAlias,
                  linkTargets,
                  onOpenDocument: (id) => navigate(browserLocalDocumentPath(id)),
                  resolveEmbed,
                }
          }
          spatial={() => (
            <div className="flex h-full min-h-0 flex-col">
              <div className="relative min-h-0 flex-1">
                {/* Keyed on canvas identity: the editor's pan/zoom, in-flight
                  gesture and open text editor all describe ONE canvas, and
                  `SpatialCanvas` carries no id for the editor to notice a
                  switch by. Without the key, switching documents silently
                  inherits the previous canvas's viewport. (The markdown
                  branch keys for the same reason.) */}
                <SpatialEditor
                  key={documentId ?? 'no-canvas'}
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
                  fileRefOptions={documents
                    .filter((entry) => entry.documentId !== documentId)
                    .map((entry) => ({
                      file: entry.documentId,
                      label: entry.name,
                      kind: entry.kind,
                    }))}
                  onOpenFileRef={(file) => {
                    // A reference names a document id; the route names a path.
                    const target = pathOfDocument(file)
                    if (target !== null) navigate(browserLocalDocumentPath(target))
                  }}
                  missingFileRef={missingFileRef}
                  {...fileSeams}
                  lockedNodeIds={lockedNodeIds}
                  lockedEdgeIds={lockedEdgeIds}
                  onToggleNodeLock={setNodeLock}
                  onOpenInEditor={nodeInEditor.open}
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
                {nodeInEditor.editing !== null && (
                  <NodeTextEditorOverlay
                    title={documentName ?? 'Untitled'}
                    initialText={nodeInEditor.editing.text}
                    theme={resolvedTheme}
                    resolveAlias={resolveAlias}
                    resolveEmbed={resolveEmbed}
                    linkTargets={linkTargets}
                    onCommit={nodeInEditor.commit}
                    onClose={nodeInEditor.close}
                    onOpenDocument={(id) => navigate(browserLocalDocumentPath(id))}
                  />
                )}
              </div>
            </div>
          )}
        />
        {/* Markdown documents keep CodeMirror's own history (its keymap
            already handles undo); the history group rides the spatial
            editor's dock via paletteLeading above. */}
      </div>
    </main>
  )
}
