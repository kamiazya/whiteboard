import { createUniqueNameResolver, serializeSpatial } from '@kamiazya/whiteboard-codec'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { isImageRef } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { LoroSyncPlugin } from 'loro-codemirror'
import { Braces, Copy, Minimize2, Trash2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  CommentsRailAside,
  CommentsRailToggle,
} from '../components/annotations/CommentsRailChrome.js'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { DocumentPreview } from '../components/DocumentPreview.js'
import { DocumentEditorSurface } from '../components/document-editor/DocumentEditorSurface.js'
import { DocumentPageShell } from '../components/document-editor/DocumentPageShell.js'
import { LoadDegradedView } from '../components/document-editor/LoadDegradedView.js'
import { SpatialEditorPane } from '../components/document-editor/SpatialEditorPane.js'
import { useNodeInEditor } from '../components/document-editor/use-node-in-editor.js'
import { DocumentProperties } from '../components/document-properties/DocumentProperties.js'
import { CanvasDisplaySettings } from '../components/spatial-editor/CanvasDisplaySettings.js'
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
import { DropdownMenuItem } from '../components/ui/dropdown-menu.js'
import {
  BROWSER_HISTORY_CAPABILITIES,
  type VersionPreviewSession,
} from '../components/VersionTimeline'
import { BookmarkAction } from '../components/workspace-top-bar/BookmarkAction.js'
import { DocumentMenu } from '../components/workspace-top-bar/DocumentMenu.js'
import { sanitizeExportFilenameBase } from '../components/workspace-top-bar/export-filename.js'
import { useBookmarkShortcut } from '../components/workspace-top-bar/useBookmarkShortcut.js'
import { useSceneExport } from '../components/workspace-top-bar/useSceneExport.js'
import { VersionPanel } from '../components/workspace-top-bar/VersionPanel.js'
import { BranchesBackendContext } from '../contexts/BranchesBackendContext.js'
import { VersionsBackendContext } from '../contexts/VersionsBackendContext.js'
import { useCommentsRail } from '../hooks/use-comments-rail.js'
import { useDocumentFavicon } from '../hooks/use-document-favicon.js'
import { useDocumentFileSeams } from '../hooks/use-document-file-seams.js'
import { useIdentityEvent } from '../hooks/use-identity-event.js'
import { useMarkdownEmbedContent } from '../hooks/use-markdown-embed-content.js'
import { useDocumentSync } from '../hooks/useDocumentSync.js'
import { useStorageHealth } from '../hooks/useStorageHealth.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import {
  documentPath as documentRoutePath,
  indexPath,
  parseWorkspaceRoute,
  workspacePath,
} from '../lib/app-routes.js'
import { captureBookmarkPicture } from '../lib/bookmark-picture.js'
import { createBrowserBranchesBackend } from '../lib/branches-backend.js'
import { BrowserBackend } from '../lib/browser-backend.js'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { createBrowserVersionsBackend } from '../lib/browser-versions-backend.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { browserWorkspaceHandleOrNull, getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import { DESTRUCTIVE_COPY } from '../lib/destructive-copy.js'
import { BROWSER_FILE_ADAPTER } from '../lib/document-embed-content.js'
import type { DocumentOutlineSource } from '../lib/document-outline.js'
import { isDocumentReadFailure } from '../lib/document-read-failure.js'
import {
  DOCUMENT_SYNC_VERSION_SAVED_EVENT,
  dispatchIdentityEvent,
} from '../lib/document-sync-types.js'
import { browserFaviconStatus } from '../lib/favicon.js'
import { sharedFoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { kindNoun } from '../lib/kind-noun.js'
import { fileRefOptions, linkEntries, linkTargets, linkTitles } from '../lib/link-entries.js'
import type { ContentClock, DefaultDocumentPointer } from '../lib/local-document-summary.js'
import { composeOutlineSource } from '../lib/outline-source.js'
import { ensurePersistentStorage } from '../lib/persistent-storage.js'
import { BROWSER_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { setShellConnection } from '../lib/shell-status-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { cn } from '../lib/utils.js'
import { buildVersionSaveBody } from '../lib/version-save-body.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { derivePageState, refineForContentReadFailure } from './browser-page-state.js'
import { mergePersistence } from './merge-persistence.js'
import {
  type LoroStoreLike,
  useBrowserDocumentController,
} from './use-browser-document-controller.js'
import { useMarkdownDocument } from './use-markdown-document.js'
import { useVersionSaveFlow } from './use-version-save-flow.js'

// WorkspaceTopBar statically imports Radix, lucide,
// VersionTimeline, HeaderBranchChip, and the Zod-validated
// @kamiazya/whiteboard-daemon-client/api-contracts/index client. None of that daemon-mode
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

const log = getAppLogger('browser-document-page')

interface BrowserDocumentPageProps {
  /** Defaults to the shared production index; injected by tests. */
  store?: DocumentIndex
  /**
   * The two app-side concerns `DocumentIndex` does not own. Defaulted inside
   * the controller, so production passes neither; a jsdom test passes both,
   * because the real ones read IndexedDB.
   */
  pointer?: DefaultDocumentPointer
  clock?: ContentClock
  // Injectable so tests can avoid the real LoroStore's IndexedDB dependency
  // (jsdom does not implement IndexedDB); production callers rely on the
  // controller hook's own default.
  loro?: LoroStoreLike
  // Defaults to the browser keeper so existing callers/tests keep working
  // unedited; App.tsx passes the resolved ProviderState's capabilities.
  capabilities?: WhiteboardCapabilities
  // A document path requested by the URL at mount (e.g. a bookmarked
  // /local/:path deep link), read once — see
  // useBrowserDocumentController's own contract for the same parameter.
  initialPath?: string
}

// Map the persistence state machine to user-facing copy. `degraded` carries its
// own message; the other states are not shown as raw enum tokens.

/**
 * The canvas name as a TITLE.
 *
 * A name equal to the document's own path is one nobody chose: the index
 * stores an unnamed document by omitting `name`, and the listing projects the
 * path back so a row always has something to show. The title box wants the
 * opposite — the placeholder, not the address — so that case becomes empty.
 */
function titleOf(name: string | null, path: string | null): string {
  return name === null || name === path ? '' : name
}

export function BrowserDocumentPage({
  // Stable across renders (the shared accessor memoizes). Living here rather
  // than in App keeps loro-crdt off the entry chunk
  // (entry-graph-loro-free.test.ts).
  store = sharedFoldingBrowserIndex(),
  loro,
  capabilities = BROWSER_CAPABILITIES,
  initialPath,
  pointer,
  clock,
}: BrowserDocumentPageProps) {
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
  } = useBrowserDocumentController(store, { loro, initialPath, pointer, clock })
  const location = useLocation()
  const navigate = useNavigate()

  // Stable across re-renders so the settings payload isn't re-read from
  // localStorage on every render.
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
    // The document this run is about, fixed before the first await. The page
    // stays mounted across a switch, so by the time the catch below runs the
    // one on screen may be a different document — and reading `documentId`
    // there would answer with this closure's own render either way.
    const startedOn = documentId
    setIsDuplicating(true)
    setDuplicateError(null)
    try {
      await duplicateDocument()
    } catch (err) {
      // Resetting on the switch is not enough on its own: this runs AFTER the
      // reset, so without the guard the failed duplicate of the document that
      // left prints its error under a document that has nothing wrong with
      // it. Same residual the save indicator had, same shape of fix.
      if (currentDocumentIdRef.current !== startedOn) return
      setDuplicateError(
        err instanceof Error ? err.message : `Failed to duplicate ${kindNoun(documentKind)}.`,
      )
    } finally {
      if (currentDocumentIdRef.current === startedOn) setIsDuplicating(false)
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
  // A ref that matches NEITHER a live id nor a live path points at a
  // deleted canvas: the editor renders a quiet "Missing reference" and hides
  // the follow affordances instead of navigating to a dead route. Paths are
  // known too — a legacy path ref names a live document, same rule as the
  // daemon page. Image refs live in the file store, not this list; undefined
  // while the list has not loaded keeps everything ordinary.
  const missingFileRef = useMemo(() => {
    if (documents.length === 0) return undefined
    const known = new Set(documents.flatMap((entry) => [entry.documentId, entry.path]))
    return (ref: string) => !isImageRef(ref) && !known.has(ref)
  }, [documents])
  // Fullscreen target for WorkspaceTopBar's onToggleFullscreen; the whole page
  // (editor + chrome), not just the Excalidraw canvas.
  const mainRef = useRef<HTMLElement | null>(null)
  // Stable canvas id from the loaded snapshot; null while not yet loaded.
  const documentId = pageState.kind === 'editing' ? pageState.snapshot.documentId : null

  // Mirrors the scope itself, rewritten every render: an async handler that
  // started under one document has to ask who is on screen NOW, and its own
  // closure can only answer with the render it was created in.
  const currentDocumentIdRef = useRef(documentId)
  currentDocumentIdRef.current = documentId

  // Everything above NAMES A DOCUMENT, and this page keeps its own document
  // switching rather than remounting (App.tsx says so at the mount site), so
  // none of it may outlive the document it is about.
  //
  // `confirmDelete` is the one that bites: it is a bare boolean, and
  // `triggerCleanup()` acts on whatever document the controller currently
  // holds. Nothing binds them, so a dialog opened on one document and
  // confirmed after a switch deletes the OTHER — measured, the document that
  // arrived while the dialog stood was the one that went to the Trash.
  // SCOPE RESET — see scoped-screen-state.test.ts
  useEffect(() => {
    setConfirmDelete(false)
    setDuplicateError(null)
    setIsDuplicating(false)
    // saveVersionOutcome clears itself: useVersionSaveFlow owns that reset,
    // keyed on the same documentId this effect watches.
    setHistoryOpen(false)
    setBookmarkArmed(0)
    setPreview(null)
    // The comments rail's thread/compose state clears itself:
    // useCommentsRail owns that reset, keyed on the same documentId.
  }, [documentId])
  // The loaded document's own path — the address the URL carries. Read off the
  // snapshot rather than looked up in the list, so it is known at the same
  // instant the id is, and so this effect does not re-fire every time the list
  // refreshes (which would overwrite a Back the user just performed).
  const documentPath = pageState.kind === 'editing' ? pageState.snapshot.path : null
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
        : // bodyTextOf, not a root getText: in workspace mode the doc is the
          // WORKSPACE document and this document's body sits on its tree node.
          [LoroSyncPlugin(markdownDoc.doc, (d) => markdownDoc.bodyTextOf(d))],
    [markdownDoc.doc, markdownDoc.bodyTextOf],
  )
  const currentUpdatedAt = pageState.kind === 'editing' ? pageState.snapshot.updatedAt : null

  // [[path]] resolution for the markdown preview goes through the same
  // link-entries table the daemon page reads; a stored row says
  // `documentId`/`name`, so the projection onto LinkableDocument is
  // explicit rather than structural.
  const linkableDocuments = useMemo(
    () =>
      documents.map((entry) => ({
        id: entry.documentId,
        path: entry.path,
        displayName: entry.name,
        kind: entry.kind,
      })),
    [documents],
  )
  const resolveAlias = useMemo(
    () => createUniqueNameResolver(linkEntries(linkableDocuments)),
    [linkableDocuments],
  )
  const resolveTitle = useMemo(() => linkTitles(linkableDocuments), [linkableDocuments])
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

  // Following a [[reference]]: it names a document id, the address bar names a
  // path. An id with no path is a document the list has not caught up with —
  // do nothing rather than navigate somewhere wrong.
  const navigateToDocument = useCallback(
    (id: string) => {
      const path = pathOfDocument(id)
      const handle = browserWorkspaceHandleOrNull()
      if (path !== null && handle !== null) navigate(documentRoutePath(handle, path))
    },
    [pathOfDocument, navigate],
  )

  // From switcherOptions rather than the raw list: the open document's row
  // is overlaid with its live snapshot, so the picker never offers a stale
  // name for the document being edited.
  const pickerTargets = useMemo(
    () =>
      linkTargets(
        switcherOptions.map((entry) => ({
          id: entry.documentId,
          path: entry.path,
          displayName: entry.name,
          kind: entry.kind,
        })),
        { excludeDocumentId: documentId ?? undefined },
      ),
    [switcherOptions, documentId],
  )
  // ![[embed]] bodies, pre-fetched so the layout's sync seam has content.
  const resolveEmbed = useMarkdownEmbedContent({
    body: documentKind === 'markdown' ? (markdownDoc.body ?? '') : '',
    resolveAlias,
  })

  // Canvas id -> URL: once a canvas has loaded, the address bar reflects it
  // (bookmarkable/shareable, matching the daemon side's
  // /document/:workspaceId/:path contract). This page only mounts on
  // /local/:path (App routes '/' to the list), so on a normal open the
  // first run is a no-op — the URL already matches. The first-sync REPLACE
  // exists for the stale-deep-link case: a bookmarked path that no longer
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
    if (documentPath === null) return
    const handle = browserWorkspaceHandleOrNull()
    if (handle === null) return
    const path = documentRoutePath(handle, documentPath)
    const isFirstSync = isFirstCanvasUrlSyncRef.current
    isFirstCanvasUrlSyncRef.current = false
    if (location.pathname === path) return
    navigate(path, { replace: isFirstSync })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentPath, navigate])

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
  // Whether listDocuments has answered at least once. Read by the URL ->
  // document effect to tell "this path does not exist" from "the list has not
  // arrived", which look identical in `switcherOptions`.
  const documentsEnumeratedRef = useRef(false)
  const lastKnownCanvasIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (documentId === null || documentPath === null) return
    // Recorded before any early return: a run that finds nothing to do still
    // establishes which document was loaded, and the guard below reads it to
    // tell an external navigation from this component's own pending push.
    const lastKnownDocumentId = lastKnownCanvasIdRef.current
    lastKnownCanvasIdRef.current = documentId

    const routed = parseWorkspaceRoute(location.pathname)
    const requestedPath = routed?.kind === 'document' ? routed.path : undefined
    if (requestedPath === undefined) return
    // Compared against the loaded snapshot's OWN path rather than against the
    // list, so this is right before the list has arrived — which is also what
    // makes the unknown-path branch below safe to treat as genuinely unknown.
    if (requestedPath === documentPath) return

    const requestedId = documentIdOfPath(requestedPath)
    if (requestedId === documentId) return
    if (requestedId !== null && requestedId === lastKnownDocumentId) return

    // Two ways the address bar can name something that is not the loaded
    // document, and both are the same recoverable miss: keep the document and
    // repair the URL. The path resolves to nothing (deleted, or hand-typed),
    // or it resolves and the switch then finds no record.
    const repairHandle = browserWorkspaceHandleOrNull()
    const repair = () => {
      if (repairHandle === null) return
      navigate(documentRoutePath(repairHandle, documentPath), { replace: true })
    }
    if (requestedId === null) {
      // ...but only once the list has actually been enumerated. Until then it
      // holds this document alone, so "absent" means "not known yet" and
      // repairing would overwrite a navigation to a perfectly valid document
      // with nothing to undo it. Leaving the address bar alone keeps the
      // user's intent visible; recovering the switch itself once the list
      // lands needs this effect's own-push guard restructured first, since it
      // assumes one run per loaded document.
      if (documentsEnumeratedRef.current) repair()
      return
    }
    void switchDocument(requestedId).then((switched) => {
      if (!switched) repair()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, documentId, documentPath, switchDocument])

  useEffect(() => {
    if (documentId === null) return
    const generation = ++listGenerationRef.current
    listDocuments()
      .then((list) => {
        if (generation !== listGenerationRef.current) return
        documentsEnumeratedRef.current = true
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
    () => {
      if (pageState.kind !== 'editing' || pageState.snapshot.kind === 'markdown') return null
      const snap = pageState.snapshot
      // path/kind/name ride along so connect() can place the document in the
      // workspace tree when it is not there yet — a fresh document, or a
      // record the startup fold could not classify on its own.
      return new BrowserBackend({
        documentId: snap.documentId,
        path: snap.path,
        kind: snap.kind,
        ...(snap.name === snap.path ? {} : { name: snap.name }),
      })
    },
    // Re-create backend only when documentId/kind changes; a null id means not-yet-loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentId, documentKind],
  )

  // useDocumentSync tolerates a null backend (idle, no writes) and reconnects
  // whenever the backend identity changes, so the not-yet-loaded state is
  // represented as null instead of a throwaway placeholder canvas id.
  const {
    canvas,
    annotations: spatialAnnotations,
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
    backendError,
    clearLocalUndo,
    readOutlineSource,
    persistence: syncPersistence,
  } = useDocumentSync(backend, {
    // The backend delivers the WORKSPACE document; this scopes the session's
    // reads and writes to the tree node carrying this document's content.
    ...(documentId === null ? {} : { contentDocumentId: documentId }),
  })

  // The browser's version history for this document: rows in IndexedDB,
  // restores through the backend holding the live record. Null while there
  // is no spatial backend (a markdown document, or nothing loaded yet), in
  // which case the save control is hidden below rather than left to fall
  // back onto the daemon's routes.
  const versionsBackend = useMemo(
    () =>
      backend === null
        ? null
        : createBrowserVersionsBackend({
            backend,
            store: new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index: store }),
          }),
    [backend, store],
  )
  const versionsEnabled = versionsBackend !== null

  // Unconditional, unlike `versionsBackend`: this keeper has no branches at
  // all, so there is nothing to build it out of and nothing that could make
  // it unavailable. Mounting it is what stops a branch consumer on this page
  // falling through to the context's daemon fallback and issuing a request
  // to a daemon that is not there.
  const branchesBackend = useMemo(() => createBrowserBranchesBackend(), [])
  // The panel refetches on a CHANGE of this signal. A manual save announces
  // itself on the window (the page dispatches it after the keeper
  // confirmed the save), which is the same event the daemon page bumps on.
  // The document's history column. This page keeps its own document
  // switching rather than remounting, so an open panel is cleared by hand
  // with the rest of the document-scoped state.
  const [historyOpen, setHistoryOpen] = useState(false)
  // Bumped by ⌘/Ctrl+S to open the panel with its naming field ready. The
  // chord asks for a bookmark now; it does not take one.
  const [bookmarkArmed, setBookmarkArmed] = useState(0)
  // The past state the person is LOOKING at, drawn in place of the editor.
  // Read-only by construction — see DocumentPreview — so "look, then decide"
  // cannot turn into an edit against a state that is not the document's.
  const [preview, setPreview] = useState<VersionPreviewSession | null>(null)
  const [versionRefreshSignal, setVersionRefreshSignal] = useState(0)
  // ⌘/Ctrl+S asks for a bookmark: open the history and arm its naming field.
  useBookmarkShortcut(versionsEnabled, () => {
    setHistoryOpen(true)
    setBookmarkArmed((n) => n + 1)
  })

  // Scoped to THIS document's identity — an unchecked listener refreshed on
  // any document's announcement, where the daemon page has always routed
  // the same signal through identity-checked dispatch.
  useIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, 'local', documentPath, () =>
    setVersionRefreshSignal((n) => n + 1),
  )
  // A save the History panel itself offers. The top bar's dot and ⌘/Ctrl+S
  // are the other two routes; on a phone the shortcut is nothing and the
  // dot is small, so the panel a finger opens has to carry one too — the
  // daemon page's panel does. Announced on the window like every other
  // save, which is what clears the dot and refreshes the list.
  const {
    saving: savingVersion,
    outcome: saveVersionOutcome,
    run: runVersionSave,
  } = useVersionSaveFlow(currentDocumentIdRef, documentId, async (label) => {
    // Narrowed by the precondition in `saveVersionFromPanel` below, which
    // never calls `run` (so never reaches this body) while either is null.
    if (versionsBackend === null || documentPath === null) {
      throw new Error('saveVersionFromPanel: no versions backend or document path')
    }
    // The shared body pins the beats: capture BEFORE the save, announce,
    // thumbnail riding along unawaited, re-announce once the picture lands
    // (see buildVersionSaveBody).
    return buildVersionSaveBody({
      capture: () =>
        captureBookmarkPicture(documentKind, {
          exportScene,
          body: markdownDoc.body,
        }),
      save: async (saveLabel) => {
        try {
          const saved = await versionsBackend.save(getBrowserWorkspaceId(), documentPath, {
            label: saveLabel,
          })
          return { workspaceId: getBrowserWorkspaceId(), path: documentPath, versionId: saved.id }
        } catch (err) {
          log.warn('save version from the History panel failed', err)
          throw err
        }
      },
      backend: versionsBackend,
      // The top bar addresses this document as `local`/path (its
      // `dataMode="local"` placeholder), so the dot listens under that id.
      announceRefresh: () =>
        dispatchIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, {
          workspaceId: 'local',
          path: documentPath,
        }),
      onThumbnailFailed: () => log.warn('bookmark thumbnail failed'),
    })(label)
  })
  const saveVersionFromPanel = async (label: string): Promise<void> => {
    if (versionsBackend === null || documentPath === null) return
    await runVersionSave(label)
  }

  // The second phase of the page state. `pageState` above is derived from what
  // the INDEX knows; this is what reading the CONTENT said, which can only
  // arrive after the id it needed came out of that first phase.
  const renderState = refineForContentReadFailure(
    pageState,
    isDocumentReadFailure(backendError) ? backendError : null,
  )

  /**
   * This document's conversations, whichever half of the page holds them.
   *
   * A markdown document is given no BrowserBackend on purpose (see the
   * `backend` memo), so the sync session it would speak through stays idle
   * and its annotation channel answers `[]` forever. The markdown hook reads
   * the same document-level `threads` plane off the host it already has, and
   * from here down nothing cares which of the two did the reading.
   */
  const annotations = documentKind === 'markdown' ? markdownDoc.annotations : spatialAnnotations
  // Where the CRDT still holds each passage. Only a markdown document has a
  // body for a mark to live in; the spatial side answers with nothing rather
  // than with the sync session's map, which is about a body it is not
  // showing.
  const threadMarks = documentKind === 'markdown' ? markdownDoc.threadMarks : undefined

  /**
   * The rail's write door. A markdown document is given no BrowserBackend
   * on purpose (see the `backend` memo), so there is no session for a
   * command to travel through: its writes go to the host holding it. A
   * spatial document's writes ride `onChange` like every other edit — one
   * undo step, on the annotation channel. The two doors are not a
   * duplicate: they lead to different documents, and the second exists
   * precisely because the first is closed on a note.
   */
  const commentsRail = useCommentsRail({
    scopeKey: documentId,
    threads: annotations,
    documentKind,
    markdownBody: documentKind === 'markdown' ? markdownDoc.body : null,
    threadMarks,
    canvas: documentKind === 'spatial' ? canvas : null,
    write: {
      createThread: (thread) => {
        if (documentKind === 'markdown') markdownDoc.createThread(thread)
        else onChange(canvas, { kind: 'create-thread', thread })
      },
      replyToThread: (threadId, message) => {
        if (documentKind === 'markdown') markdownDoc.replyToThread(threadId, message)
        else onChange(canvas, { kind: 'reply-to-thread', threadId, message })
      },
    },
  })

  const nodeInEditor = useNodeInEditor(canvas, onChange, documentId)

  const documentOpsFilenameBase = sanitizeExportFilenameBase(documentName ?? 'canvas')
  const { exportError, handleExport } = useSceneExport({
    onExport: exportScene,
    filenameBase: documentOpsFilenameBase,
    log,
  })

  // The seams themselves are backend-agnostic (see use-document-file-seams.ts);
  // this page only supplies the browser binding and the staleness
  // stamps that make an edit made elsewhere show up on the next refresh.
  const fileSeams = useDocumentFileSeams({
    canvas,
    adapter: BROWSER_FILE_ADAPTER,
    stampOf: useMemo(
      () => new Map(documents.map((entry) => [entry.documentId, entry.updatedAt])),
      [documents],
    ),
  })

  const commands = useWhiteboardCommands({
    provider: { kind: 'browser', capabilities },
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

  // One account of the document's writes over its three writers — the
  // controller (renames), the markdown body's own save, and the spatial sync
  // session — worst first, because the writer that is behind is the one
  // holding unsaved work. A FACT, not a display state: the page shows nothing
  // for the ordinary unsaved few hundred milliseconds while someone types.
  // What it shows is the judgement below, and only when there is one.
  const writes = mergePersistence(
    mergePersistence(persistence, markdownDoc.saveState),
    syncPersistence,
  )
  const storageHealth = useStorageHealth(writes)

  // The connection is app-level, so the App-mounted shell draws it and this
  // page only reports what it knows: while a document kept in this browser
  // is open, the data lives in this browser and nowhere else — and whether
  // that browser is keeping it (`storage`). The last landed write goes with
  // it, for the popover to answer "is it saved" on asking. Cleared on
  // unmount so an index page makes no claim of its own.
  const lastWrittenAt = writes.lastSavedAt
  useEffect(() => {
    setShellConnection({ state: { keeper: 'browser', storage: storageHealth }, lastWrittenAt })
    return () => setShellConnection(null)
  }, [storageHealth, lastWrittenAt])

  // Tab favicon: the same judgement as the shell mark (quiet unless a write
  // is stuck or refused), scene content as the minimap. Which owner holds
  // THIS document — see `composeOutlineSource`, which is where the two of
  // them and the reason are written down.
  const readDocumentOutlineSource = useCallback(
    (kind: DocumentKind): DocumentOutlineSource | null =>
      composeOutlineSource(kind, readOutlineSource, markdownDoc),
    [readOutlineSource, markdownDoc],
  )
  useDocumentFavicon({
    settingsStore,
    documentId,
    kind: documentKind,
    revision: documentKind === 'markdown' ? markdownDoc.body : canvas,
    readSource: readDocumentOutlineSource,
    status: browserFaviconStatus(storageHealth),
  })

  // The facts themselves, published for tests and nothing else: hidden, so
  // the row shows no save state, while a wait can still require a landed
  // write that covers what was typed (`test-utils/wait-for-saved.ts`).
  const persistenceFact = (
    <span
      hidden
      data-testid="persistence-state"
      data-save-state={writes.kind}
      {...(writes.lastSavedAt === null ? {} : { 'data-last-saved-at': writes.lastSavedAt })}
    />
  )

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

  if (renderState.kind === 'load-degraded') {
    return (
      <LoadDegradedView message={renderState.message}>
        {/* WHICH recovery is offered follows what the failure knows, and
            getting it wrong is destructive rather than merely unhelpful:
            `Start fresh` deletes the record, which is the right last resort
            for a document this build cannot read, and the worst possible
            button for one whose read was simply blocked — the data is
            intact and one click removes it. So the retry is what an
            unavailable read gets, and it is the only affordance there. */}
        {backendError === 'read-unavailable' ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
          >
            Try again
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void startFresh()}
            className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
          >
            Start fresh
          </button>
        )}
      </LoadDegradedView>
    )
  }

  if (renderState.kind === 'cleanup-completed') {
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

  if (renderState.kind === 'loading') {
    return <DocumentPageSkeleton label="Loading canvas" />
  }

  // Whole-document operations live behind a kebab: duplicate and delete
  // are rare actions, and rare + destructive earns a menu (with words)
  // over two always-visible icon buttons. One JSX value shared by both
  // canvas-kind branches so the two rows cannot drift apart.
  // The opener belongs in the document's own actions row, not floated over the
  // editor: measured, a control absolutely positioned in the surface's
  // top-right corner sat on top of the markdown editor's catalog trigger and
  // intercepted every click meant for it. Both editor kinds put chrome in
  // their corners, and the annotation layer is a document-level concern, so
  // the row that already carries document-level verbs is where it goes.
  const commentsToggle = <CommentsRailToggle rail={commentsRail} />

  const canvasRowActions = (
    <>
      {commentsToggle}
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
      <DocumentMenu
        onExport={(format) => void handleExport(format)}
        triggerRef={canvasOpsButtonRef}
      >
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
      </DocumentMenu>
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
            <AlertDialogTitle>Delete this {kindNoun(documentKind)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {DESTRUCTIVE_COPY['delete-document-browser'](kindNoun(documentKind))}
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
      // Surfaced through persistence state: a refused write reaches the
      // shell mark as `failed`, and the page's degraded screen.
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
          // No save state in the row: the shell mark answers for the keeper,
          // and only when there is a condition. The hidden fact is for tests.
          status={persistenceFact}
          actions={canvasRowActions}
          title={titleOf(documentName, documentPath)}
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
        status={persistenceFact}
        settings={<CanvasDisplaySettings canvas={canvas} onChange={onChange} />}
        actions={canvasRowActions}
        title={titleOf(documentName, documentPath)}
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
    <VersionsBackendContext.Provider value={versionsBackend}>
      <BranchesBackendContext.Provider value={branchesBackend}>
        <DocumentPageShell
          srTitle={renderState.snapshot.name}
          mainRef={mainRef}
          mainClassName="bg-background"
          aside={
            historyOpen && versionsEnabled ? (
              <VersionPanel
                workspaceId={getBrowserWorkspaceId()}
                path={renderState.snapshot.path}
                capabilities={BROWSER_HISTORY_CAPABILITIES}
                onRestored={clearLocalUndo}
                onPreview={setPreview}
                refreshSignal={versionRefreshSignal}
                headerActions={
                  <BookmarkAction
                    saving={savingVersion}
                    outcome={saveVersionOutcome}
                    armed={bookmarkArmed}
                    onSave={(label) => void saveVersionFromPanel(label)}
                  />
                }
              />
            ) : undefined
          }
          header={
            <>
              {/* Fullscreen means the CANVAS, maximised: the whole top-bar row —
            switcher, rename, menus — steps aside. The floating control below
            replaces its exit path, Escape still works natively, and the dock
            stays because editing is what the extra space is FOR. */}
              {!isFullscreen && (
                <Suspense
                  fallback={
                    <div
                      className={cn(TOP_BAR_FALLBACK_HEIGHT, 'shrink-0 border-b bg-background')}
                    />
                  }
                >
                  <WorkspaceTopBar
                    // Local mode names documents through its own store, not through
                    // the daemon's `/names`, so the identity the bar offers is unused
                    // here and `documentName`/`onTitleChange` stay the source.
                    titleSlot={() => documentTitleSlot}
                    dataMode="local"
                    workspaceId="local"
                    path={renderState.snapshot.path}
                    // The way out of the editor. This page had none until now —
                    // the app-shell brand mark was the only exit, and it says
                    // nothing about where it goes.
                    onNavigateBack={() => {
                      const handle = browserWorkspaceHandleOrNull()
                      navigate(handle === null ? indexPath() : workspacePath(handle))
                    }}
                    isFullscreen={isFullscreen}
                    onToggleFullscreen={() => {
                      // Entering hides this whole bar; the floating exit control and
                      // native Escape are the ways back out. requestFullscreen can
                      // REJECT (Permissions-Policy, an iframe without
                      // allow="fullscreen", no user activation) — a swallowed
                      // rejection is unhandled-rejection noise, so both directions log.
                      if (document.fullscreenElement)
                        document
                          .exitFullscreen()
                          .catch((err) => log.warn('exitFullscreen failed', err))
                      else
                        mainRef.current
                          ?.requestFullscreen()
                          .catch((err) => log.warn('requestFullscreen rejected', err))
                    }}
                    capabilities={capabilities}
                    onToggleHistory={
                      versionsEnabled ? () => setHistoryOpen((open) => !open) : undefined
                    }
                    historyOpen={historyOpen}
                    {...(preview === null ? {} : { preview })}
                  />
                </Suspense>
              )}
            </>
          }
        >
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
          {/* The annotation layer's document-level surface (ADR-0026
            decision 5) sits BESIDE the editor rather than inside it,
            because one panel serves both document kinds and a markdown
            document has no canvas chrome to host one. Its opener lives in
            the document actions row above, in flow — see commentsToggle. */}
          <div className="flex h-full min-h-0">
            <div className="relative min-w-0 flex-1">
              {preview ? (
                <DocumentPreview past={preview.past} theme={resolvedTheme} />
              ) : (
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
                          title: titleOf(documentName, documentPath),
                          resolveAlias,
                          resolveTitle,
                          linkTargets: pickerTargets,
                          onOpenDocument: (id) => navigateToDocument(id),
                          resolveEmbed,
                          threads: annotations,
                          threadMarks,
                          selectedThreadId: commentsRail.selectedThreadId,
                          onSelectThread: commentsRail.revealThread,
                          onComposeThread: commentsRail.composeThread,
                        }
                  }
                  spatial={() => (
                    <div className="flex h-full min-h-0 flex-col">
                      <SpatialEditorPane
                        className="relative min-h-0 flex-1"
                        editorKey={documentId ?? 'no-canvas'}
                        canvasLoaded={canvasLoaded}
                        canvas={canvas}
                        onChange={onChange}
                        externalVersion={externalVersion}
                        theme={resolvedTheme}
                        // File-node reference = canvas id minted in the browser;
                        // the same rows the link picker offers (open document
                        // excluded, live-snapshot overlay), under the picker's
                        // field names.
                        fileRefOptions={fileRefOptions(pickerTargets)}
                        onOpenDocument={navigateToDocument}
                        missingFileRef={missingFileRef}
                        fileSeams={fileSeams}
                        lockedNodeIds={lockedNodeIds}
                        lockedEdgeIds={lockedEdgeIds}
                        onToggleNodeLock={setNodeLock}
                        onToggleEdgeLock={setEdgeLock}
                        nodeInEditor={nodeInEditor}
                        history={{
                          onUndo: () => void undo(),
                          onRedo: () => void redo(),
                          canUndo: canUndo(),
                          canRedo: canRedo(),
                        }}
                        overlayTitle={documentName ?? 'Untitled'}
                        resolveAlias={resolveAlias}
                        resolveEmbed={resolveEmbed}
                        resolveTitle={resolveTitle}
                        linkTargets={pickerTargets}
                        threads={annotations}
                      />
                    </div>
                  )}
                />
              )}
              {/* Markdown documents keep CodeMirror's own history (its keymap
            already handles undo); the history group rides the spatial
            editor's dock via paletteLeading above. */}
            </div>
            {/* Not while a past version is on screen: the editor is replaced
                by DocumentPreview but this rail is not, and its writes go to
                the LIVE document. */}
            <CommentsRailAside
              rail={commentsRail}
              threads={annotations}
              writable={preview === null}
            />
          </div>
        </DocumentPageShell>
      </BranchesBackendContext.Provider>
    </VersionsBackendContext.Provider>
  )
}
