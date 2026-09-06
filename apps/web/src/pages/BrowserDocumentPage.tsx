import { createUniqueNameResolver, serializeSpatial } from '@kamiazya/whiteboard-codec'
import type { VersionEntry } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { createCheckpointScheduler, readBranchesFromRecord } from '@kamiazya/whiteboard-history'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { isImageRef } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { LoroSyncPlugin } from 'loro-codemirror'
import { Braces, Copy, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { LoadDegradedView } from '../components/document-editor/LoadDegradedView.js'
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
import { DropdownMenuItem } from '../components/ui/dropdown-menu.js'
import { BROWSER_HISTORY_CAPABILITIES } from '../components/VersionTimeline'
import { BranchesBackendContext } from '../contexts/BranchesBackendContext.js'
import { VersionsBackendContext } from '../contexts/VersionsBackendContext.js'
import type { CommentsRailWrite } from '../hooks/use-comments-rail.js'
import { useDocumentFavicon } from '../hooks/use-document-favicon.js'
import { useIdentityEvent } from '../hooks/use-identity-event.js'
import { useDocumentSync } from '../hooks/useDocumentSync.js'
import { useStorageHealth } from '../hooks/useStorageHealth.js'
import { getAppLogger } from '../lib/app-logger.js'
import {
  documentPath as documentRoutePath,
  indexPath,
  parseWorkspaceRoute,
  workspacePath,
} from '../lib/app-routes.js'
import { BrowserBackend } from '../lib/browser-backend.js'
import { createBrowserBranchesBackend } from '../lib/browser-branches-backend.js'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { createBrowserVersionsBackend } from '../lib/browser-versions-backend.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { browserWorkspaceHandleOrNull, getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
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
import { linkEntries, linkTargets, linkTitles } from '../lib/link-entries.js'
import type { ContentClock, DefaultDocumentPointer } from '../lib/local-document-summary.js'
import { composeOutlineSource } from '../lib/outline-source.js'
import { ensurePersistentStorage } from '../lib/persistent-storage.js'
import { setShellConnection } from '../lib/shell-status-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { derivePageState, refineForContentReadFailure } from './browser-page-state.js'
import { DocumentPage } from './DocumentPage.js'
import type {
  DocumentKeeper,
  DocumentKeeperAnswer,
  DocumentKeeperEvents,
} from './document-keeper.js'
import type { DocumentPageModel } from './document-page-model.js'
import { mergePersistence } from './merge-persistence.js'
import {
  type LoroStoreLike,
  useBrowserDocumentController,
} from './use-browser-document-controller.js'
import { useMarkdownDocument } from './use-markdown-document.js'

const log = getAppLogger('browser-document-page')

export interface BrowserDocumentPageProps {
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
  // A document path requested by the URL at mount (e.g. a bookmarked
  // /local/:path deep link), read once — see
  // useBrowserDocumentController's own contract for the same parameter.
  initialPath?: string
}

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

/**
 * The browser keeper: the controller over IndexedDB, the spatial sync session
 * over `BrowserBackend`, the markdown body over its own Loro binding, and the
 * browser's version rows — answered to the shared `DocumentPage` as one model
 * (ADR-0004 decision 2: the controller layer stays capability-selected, the
 * page does not).
 */
function useBrowserDocument(
  {
    // Stable across renders (the shared accessor memoizes). Living here rather
    // than in App keeps loro-crdt off the entry chunk
    // (entry-graph-loro-free.test.ts).
    store = sharedFoldingBrowserIndex(),
    loro,
    initialPath,
    pointer,
    clock,
  }: BrowserDocumentPageProps,
  events: DocumentKeeperEvents,
): DocumentKeeperAnswer {
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
  // SCOPE RESET — see scoped-screen-state.test.ts. The history column, the
  // save outcome and the comments rail clear themselves inside DocumentPage,
  // keyed on the same documentId this effect watches.
  useEffect(() => {
    setConfirmDelete(false)
    setDuplicateError(null)
    setIsDuplicating(false)
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
    // The SEARCH rides along, because this writes the address of the document
    // already loaded rather than navigating to another one. A bare pathname
    // drops the query — which is how `?v=<variation>` never survived to be
    // read on this keeper: the deep link arrived, this effect replaced the
    // address with the pathname alone, and the preview had nothing left to
    // resolve. (`navigateToDocument` and the repair below DO drop it: both
    // name a different document, and a variation qualifies one document.)
    navigate({ pathname: path, search: location.search }, { replace: isFirstSync })
  }, [documentPath, navigate, location.search])

  // URL -> canvas id: browser Back/Forward (and any other history navigation)
  // moves location.pathname without any switcher click firing, so this is the
  // only thing that keeps the loaded canvas in sync with the address bar for
  // that direction. Runs in an effect (never during render) so it can't race
  // the editor's own render cycle; switchDocument's generation guard (see the
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
    [documentId, documentKind],
  )

  // The store, not the seam, is what a merge's pre-merge point needs: the
  // seam's `save` carries a label and nothing else, while a checkpoint has to
  // say it is automatic and which variation it belongs to. So it is built
  // once here and handed to both.
  const versionStore = useMemo(
    () => new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index: store }),
    [store],
  )

  // Automatic checkpoints, on the same mechanic the daemon runs
  // (`@kamiazya/whiteboard-history`): a trailing debounce that lands a point
  // once the document has been quiet, so a row marks where a person stopped
  // rather than an arbitrary interval.
  //
  // The `doc` the scheduler is handed is the WORKSPACE RECORD, not this
  // document's content — it uses the frontier only to ask "has anything
  // changed since the last checkpoint", and the record's frontier is what
  // the store saves. Keying on the content doc would compare a frontier
  // against a row taken from a different one, and never match.
  const checkpoints = useMemo(() => {
    const scheduler = createCheckpointScheduler<VersionEntry>({
      save: (workspaceId, path, _doc, branchName) =>
        versionStore.save(workspaceId, path, {
          auto: true,
          ...(branchName === null ? {} : { branchName }),
          // The person at this browser is not who took this one.
          operator: { kind: 'system', peerId: 'browser', displayName: 'auto-save' },
        }),
      getHeadBranch: async (_workspaceId, _path) =>
        backend?.readRecord((doc, id) => readBranchesFromRecord(doc, id)?.head ?? null) ?? null,
      onError: (err) => log.warn('automatic checkpoint failed', err),
    })
    return scheduler
  }, [backend, versionStore])

  // Bound to the record the backend holds, and a no-op until one is there.
  const checkpointPair = useMemo(() => {
    const signal = (): void => {
      // A document with no path yet has nowhere to file a row; the record
      // is what a checkpoint points at, so both must be there.
      if (documentPath === null) return
      // Total, and deliberately so. This runs inside Loro's local-update
      // subscriber, where a throw does not fail the edit — it escapes as an
      // UNHANDLED REJECTION, which vitest reports as `Errors 1` with every
      // test still passing and only the exit code red. A missed checkpoint is
      // not worth that, and nothing here is worth failing an edit for either:
      // a backend that cannot answer for a record has no record to bookmark.
      try {
        const record = backend?.readRecord?.((doc) => doc) ?? null
        if (record !== null) checkpoints(getBrowserWorkspaceId(), documentPath, record)
      } catch (err) {
        log.warn('could not arm an automatic checkpoint', err)
      }
    }
    return {
      signal,
      // Signal, THEN flush. The session flushes the pending edit before
      // calling this, but the commit that performs reaches
      // `subscribeLocalUpdates` — where `signal` lives — only on a later
      // microtask, so flushing alone finds nothing armed and a person who
      // edits and closes the tab leaves no checkpoint. Signalling here arms
      // it against the record as it stands, which is what a checkpoint
      // points at anyway: the store saves the frontier that is ON DISK, so
      // an edit still in flight is simply not part of this point, rather
      // than making it wrong.
      flush: () => {
        signal()
        void checkpoints.flush()
      },
    }
  }, [backend, checkpoints, documentPath])

  // Nothing pending survives leaving this document for another.
  useEffect(() => () => checkpoints.stop(), [checkpoints])

  // useDocumentSync tolerates a null backend (idle, no writes) and reconnects
  // whenever the backend identity changes, so the not-yet-loaded state is
  // represented as null instead of a throwaway placeholder canvas id.
  const sync = useDocumentSync(backend, {
    // The backend delivers the WORKSPACE document; this scopes the session's
    // reads and writes to the tree node carrying this document's content.
    ...(documentId === null ? {} : { contentDocumentId: documentId }),
    checkpoints: checkpointPair,
  })
  const {
    canvas,
    annotations: spatialAnnotations,
    onChange,
    backendError,
    readOutlineSource,
    persistence: syncPersistence,
  } = sync
  // The record is not readable at mount — the backend delivers it a beat
  // later — so anything that reads the branch plane on mount gets the resting
  // state, HEAD `main`. `useBranches` refetches only when its keeper or
  // document changes, neither of which happens when the record lands, so a
  // document opened ON a variation kept saying `Main`: the chip named the
  // wrong one and the combine banner, which needs a non-default HEAD, could
  // never appear. This is the signal the daemon page has always had; the
  // browser simply never supplied one.
  const [branchRefreshSignal, setBranchRefreshSignal] = useState(0)
  useEffect(() => {
    if (!sync.loaded) return
    setBranchRefreshSignal((n) => n + 1)
  }, [sync.loaded])

  // The browser's version history for this document: rows in IndexedDB,
  // restores through the backend holding the live record. Null while there
  // is no spatial backend (a markdown document, or nothing loaded yet), in
  // which case the save control is hidden rather than left to fall back onto
  // the daemon's routes.
  const versionsBackend = useMemo(
    () =>
      backend === null ? null : createBrowserVersionsBackend({ backend, store: versionStore }),
    [backend, versionStore],
  )
  const versionsEnabled = versionsBackend !== null

  // Built on the backend, because a branch is a frontier of the record the
  // backend holds and a branch write goes through the same queue its edits
  // do. Mounting it is also what stops a branch consumer on this page falling
  // through to the context's daemon fallback and issuing a request to a
  // daemon that is not there — which was this provider's whole job while the
  // keeper had no branches, and remains true now that it has them.
  const branchesBackend = useMemo(
    // The version store rides along so a merge can leave the point before it.
    // Same instance the versions seam uses, so a pre-merge point is an
    // ordinary row in the same history rather than a second kind of record.
    () => createBrowserBranchesBackend({ backend, versions: versionStore }),
    [backend, versionStore],
  )
  // A manual save announces itself on the window (dispatched after the
  // keeper confirmed the save), and the page's history column re-reads on
  // it. Scoped to THIS document's identity — an unchecked listener refreshed
  // on any document's announcement, where the daemon keeper has always
  // routed the same signal through identity-checked dispatch.
  useIdentityEvent(
    DOCUMENT_SYNC_VERSION_SAVED_EVENT,
    'local',
    documentPath,
    events.onVersionCreated,
  )

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
  const threadWrite: CommentsRailWrite = {
    createThread: (thread) => {
      if (documentKind === 'markdown') markdownDoc.createThread(thread)
      else onChange(canvas, { kind: 'create-thread', thread })
    },
    replyToThread: (threadId, message) => {
      if (documentKind === 'markdown') markdownDoc.replyToThread(threadId, message)
      else onChange(canvas, { kind: 'reply-to-thread', threadId, message })
    },
    setThreadStatus: (threadId, status) => {
      if (documentKind === 'markdown') markdownDoc.setThreadStatus(threadId, status)
      else onChange(canvas, { kind: 'set-thread-status', threadId, status })
    },
    editMessage: (threadId, message, opening) => {
      if (documentKind === 'markdown') markdownDoc.editMessage(threadId, message)
      else onChange(canvas, { kind: 'edit-thread-message', threadId, message, opening })
    },
  }

  // Staleness stamps for the file seams: an edit made elsewhere shows up on
  // the next refresh because the referenced document's updatedAt moved.
  const stampOf = useMemo(
    () => new Map(documents.map((entry) => [entry.documentId, entry.updatedAt])),
    [documents],
  )

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

  if (renderState.kind === 'load-degraded') {
    return {
      kind: 'terminal',
      node: (
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
      ),
    }
  }

  if (renderState.kind === 'cleanup-completed') {
    return {
      kind: 'terminal',
      node: (
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
      ),
    }
  }

  if (renderState.kind === 'loading') {
    return { kind: 'terminal', node: <DocumentPageSkeleton label="Loading canvas" /> }
  }

  const loadedPath = renderState.snapshot.path
  const workspaceId = getBrowserWorkspaceId()

  // The name goes to the workspace and NOWHERE else: it is a property of the
  // document's place, not of its content (ADR-0009 decision 2), so the
  // snapshot row is the one copy and the OKF `title` is projected from it on
  // export.
  const onTitleChange = (next: string) => {
    void renameDocument(next).catch(() => {
      // Surfaced through persistence state: a refused write reaches the
      // shell mark as `failed`, and the page's degraded screen.
    })
  }
  const title = titleOf(documentName, documentPath)

  const model: DocumentPageModel = {
    scopeKey: documentId,
    documentKey: documentId ?? 'no-canvas',
    documentKind,
    srTitle: renderState.snapshot.name,
    sync,
    markdown: {
      body: markdownDoc.body,
      setBody: markdownDoc.setBody,
      sourceExtensions: markdownBinding,
      autoFocus: true,
      // No facets at all for a SPATIAL canvas: a facet is OKF frontmatter
      // that JSON Canvas has nowhere to put (ADR-0009 decision 3).
      meta: markdownDoc.coreFacets ?? { type: documentKind },
      title,
      hydrating: markdownDoc.coreFacets === null,
    },
    title: { value: title, onChange: onTitleChange },
    properties: {
      ready:
        documentKind !== 'markdown' ||
        (markdownDoc.body !== null && markdownDoc.coreFacets !== null),
      ...(documentKind === 'markdown' && markdownDoc.coreFacets !== null
        ? { facets: markdownDoc.coreFacets, onFacetsChange: markdownDoc.setCoreFacets }
        : {}),
      status: persistenceFact,
    },
    threads: {
      annotations,
      threadMarks,
      write: threadWrite,
      railCanvas: documentKind === 'spatial' ? canvas : null,
    },
    files: {
      adapter: BROWSER_FILE_ADAPTER,
      stampOf,
      resolveAlias,
      resolveTitle,
      missingFileRef,
      pickerTargets,
    },
    openDocument: navigateToDocument,
    overlayTitle: documentName ?? 'Untitled',
    exportFilenameBase: documentName ?? 'canvas',
    commands: {
      provider: { kind: 'browser' },
      canvas: documentId !== null ? { documentId, name: documentName ?? '' } : null,
      registryKey: documentId,
    },
    versions: {
      enabled: versionsEnabled,
      workspaceId,
      path: loadedPath,
      historyCapabilities: BROWSER_HISTORY_CAPABILITIES,
      backend: versionsBackend,
      save: async (label) => {
        if (versionsBackend === null) {
          throw new Error('saveVersionFromPanel: no versions backend')
        }
        try {
          const saved = await versionsBackend.save(workspaceId, loadedPath, { label })
          return { workspaceId, path: loadedPath, versionId: saved.id }
        } catch (err) {
          log.warn('save version from the History panel failed', err)
          throw err
        }
      },
      // The top bar addresses this document as `local`/path (its
      // `dataMode="local"` placeholder), so the dot listens under that id.
      announceRefresh: () =>
        dispatchIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, {
          workspaceId: 'local',
          path: loadedPath,
        }),
    },
    topBar: {
      // Local mode names documents through its own store, not through the
      // daemon's `/names`, so the identity the bar offers is unused here and
      // `title`/`onTitleChange` stay the source.
      workspaceId: 'local',
      path: loadedPath,
      dataMode: 'local',
      branchRefreshSignal,
      // The way out of the editor. This page had none until now — the
      // app-shell brand mark was the only exit, and it says nothing about
      // where it goes.
      onNavigateBack: () => {
        const handle = browserWorkspaceHandleOrNull()
        navigate(handle === null ? indexPath() : workspacePath(handle))
      },
    },
    spatial: {},
    slots: {
      rowAlerts: (
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
        </>
      ),
      menuTriggerRef: canvasOpsButtonRef,
      menuItems: (
        <>
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
        </>
      ),
      afterMenu: (
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
      ),
    },
  }

  return {
    kind: 'render',
    model,
    wrap: (page: ReactNode) => (
      <VersionsBackendContext.Provider value={versionsBackend}>
        <BranchesBackendContext.Provider value={branchesBackend}>
          {page}
        </BranchesBackendContext.Provider>
      </VersionsBackendContext.Provider>
    ),
  }
}

export const browserKeeper: DocumentKeeper<BrowserDocumentPageProps> = {
  kind: 'browser',
  useDocument: useBrowserDocument,
}

/** The shared page, bound to the browser keeper — what App mounts under the browser keeper's routes. */
export function BrowserDocumentPage(props: BrowserDocumentPageProps) {
  return <DocumentPage keeper={browserKeeper} props={props} />
}
