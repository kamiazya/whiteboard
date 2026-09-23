import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { Braces, Copy, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from '../components/ui/alert-dialog.js'
import { DropdownMenuItem } from '../components/ui/dropdown-menu.js'
import { VersionsBackendContext } from '../contexts/VersionsBackendContext.js'
import { spatialThreadWrite } from '../hooks/spatial-thread-write.js'
import { useDocumentFavicon } from '../hooks/use-document-favicon.js'
import { useIdentityEvent } from '../hooks/use-identity-event.js'
import { useLinkResolution } from '../hooks/use-link-resolution.js'
import { useTagVocabulary } from '../hooks/use-tag-vocabulary.js'
import { useDocumentSync } from '../hooks/useDocumentSync.js'
import { useStorageHealth } from '../hooks/useStorageHealth.js'
import { getAppLogger } from '../lib/app-logger.js'
import { documentPath as documentRoutePath, indexPath, workspacePath } from '../lib/app-routes.js'
import { BrowserBackend } from '../lib/browser-backend.js'
import { BrowserVersionStore } from '../lib/browser-version-store.js'
import { createBrowserVersionsBackend } from '../lib/browser-versions-backend.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { browserWorkspaceHandleOrNull, getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { DESTRUCTIVE_COPY } from '../lib/destructive-copy.js'
import { BROWSER_FILE_ADAPTER } from '../lib/document-embed-content.js'
import type { DocumentOutlineSource } from '../lib/document-outline.js'
import { isDocumentReadFailure } from '../lib/document-read-failure.js'
import { resolveOpenDocumentSymbol } from '../lib/document-symbol.js'
import { DOCUMENT_SYNC_VERSION_SAVED_EVENT } from '../lib/document-sync-types.js'
import { browserFaviconStatus } from '../lib/favicon.js'
import { sharedFoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { kindNoun } from '../lib/kind-noun.js'
import type { ContentClock, DefaultDocumentPointer } from '../lib/local-document-summary.js'
import { createLocalFilesSource } from '../lib/local-files-source.js'
import { loroTextSync } from '../lib/loro-codemirror-sync.js'
import { composeOutlineSource } from '../lib/outline-source.js'
import { ensurePersistentStorage } from '../lib/persistent-storage.js'
import { setShellConnection } from '../lib/shell-status-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import {
  browserConnectionsSlot,
  browserTerminalAnswer,
  browserVersionsSlot,
  conversationReads,
  documentLabels,
  documentPropertiesSlot,
  loadedSnapshotOf,
  markdownThreadWrite,
  withLiveSnapshot,
} from './browser-document-slots.js'
import { derivePageState, refineForContentReadFailure } from './browser-page-state.js'
import { DocumentPage } from './DocumentPage.js'
import type {
  DocumentKeeper,
  DocumentKeeperAnswer,
  DocumentKeeperEvents,
} from './document-keeper.js'
import type { DocumentPageModel } from './document-page-model.js'
import { mergePersistence } from './merge-persistence.js'
import { useAutoCheckpoint } from './use-auto-checkpoint.js'
import { useBrowserConnections } from './use-browser-connections.js'
import {
  type LoroStoreLike,
  useBrowserDocumentController,
} from './use-browser-document-controller.js'
import { useBrowserRouteSync } from './use-browser-route-sync.js'
import { useDocumentListRefresh } from './use-document-list-refresh.js'
import { useDuplicateDocument } from './use-duplicate-document.js'
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

  const [confirmDelete, setConfirmDelete] = useState(false)
  const canvasOpsButtonRef = useRef<HTMLButtonElement | null>(null)

  const pageState = derivePageState({ snapshot, persistence, cleanupCompleted })

  // Stable canvas id from the loaded snapshot; null while not yet loaded.
  const loaded = loadedSnapshotOf(pageState)
  const documentId = loaded.documentId

  // Mirrors the scope itself, rewritten every render: an async handler that
  // started under one document has to ask who is on screen NOW, and its own
  // closure can only answer with the render it was created in.
  const currentDocumentIdRef = useRef(documentId)
  currentDocumentIdRef.current = documentId

  // State that NAMES A DOCUMENT may not outlive it: this page keeps its own
  // document switching rather than remounting (App.tsx says so at the mount
  // site). Duplicate's half of that rule moved into use-duplicate-document.ts
  // with the state it clears; what is left here is the delete dialog.
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
  }, [documentId])
  // The loaded document's own path — the address the URL carries. Read off the
  // snapshot rather than looked up in the list, so it is known at the same
  // instant the id is, and so this effect does not re-fire every time the list
  // refreshes (which would overwrite a Back the user just performed).
  const { documentPath, documentName, documentKind } = loaded
  // Called HERE rather than above with the rest of the state: its refusal is
  // worded with `documentKind`, and the handler closed over three consts
  // declared below it — legal only because the body runs later.
  const { isDuplicating, duplicateError, handleDuplicate } = useDuplicateDocument({
    documentId,
    currentDocumentIdRef,
    documentKind,
    duplicateDocument,
  })
  // Filled in below, once the checkpoint pair exists. A ref because the hook
  // runs before that point in this component and a callback identity is not
  // what the subscription should depend on — the same shape the hook uses for
  // its own save scheduler.
  const checkpointSignalRef = useRef<(() => void) | null>(null)
  const signalCheckpoint = useCallback(() => checkpointSignalRef.current?.(), [])
  const markdownDoc = useMarkdownDocument(
    resolvedLoro,
    documentId,
    documentKind === 'markdown',
    signalCheckpoint,
  )
  // The workspace's tag vocabulary (ADR-0040 decision 5), read through the
  // same files source the document browser uses over the same stores, once
  // per page — the browser keeper answers it by opening every document.
  const tagsSource = useMemo(
    () => createLocalFilesSource({ index: store, loro: resolvedLoro }),
    [store, resolvedLoro],
  )
  const tagVocabulary = useTagVocabulary(tagsSource)
  // Binds CodeMirror straight to the document's 'body' text container: each
  // change is written at its OWN position, and an external change moves the
  // local caret exactly. The hook's doc subscription keeps body state and the
  // save schedule in step, so onChange has nothing left to do.
  //
  // NOT, as this said until it was measured, "unlike setBody's wholesale
  // replace": `minimalChange` is minimal, and identical for one keystroke.
  // They differ on a transaction editing two places at once, where one span
  // covers both — the untouched middle re-inserted, its passage marks gone.
  const markdownBinding = useMemo(
    () =>
      markdownDoc.doc === null
        ? undefined
        : // bodyTextOf, not a root getText: in workspace mode the doc is the
          // WORKSPACE document and this document's body sits on its tree node.
          [loroTextSync(markdownDoc.doc, (d) => markdownDoc.bodyTextOf(d))],
    [markdownDoc.doc, markdownDoc.bodyTextOf],
  )
  const currentUpdatedAt = loaded.updatedAt
  // Called HERE rather than with the rest of the state above: it reads
  // `currentUpdatedAt`, and it OWNS the enumerated flag the URL -> document
  // effect below reads. The list and its two readers now sit in that order.
  const { documents, enumeratedRef: documentsEnumeratedRef } = useDocumentListRefresh({
    documentId,
    currentUpdatedAt,
    listDocuments,
  })
  // A ref that matches NEITHER a live id nor a live path points at a
  // deleted canvas: the editor renders a quiet "Missing reference" and hides
  // the follow affordances instead of navigating to a dead route. Paths are
  // known too — a legacy path ref names a live document, same rule as the
  // daemon page. Image refs live in the file store, not this list; undefined
  // while the list has not loaded keeps everything ordinary.
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
  // The list read races the save a rename queues, so this canvas's live
  // truth is its own snapshot and the list is only the copy for the OTHER
  // documents. Both the switcher and the link picker read THIS, or the
  // picker would offer a stale name for the document being edited — or omit
  // it entirely right after it was created.
  const switcherOptions = withLiveSnapshot(documents, pageState)
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

  // The picker reads switcherOptions rather than the raw list: the open
  // document's row is overlaid with its live snapshot, so it never offers a
  // stale name for the document being edited. The other three resolutions
  // read the raw list, which is why the hook takes both.
  const pickerDocuments = useMemo(
    () =>
      switcherOptions.map((entry) => ({
        id: entry.documentId,
        path: entry.path,
        displayName: entry.name,
        kind: entry.kind,
      })),
    [switcherOptions],
  )
  const { resolveAlias, resolveTitle, missingFileRef, pickerTargets } = useLinkResolution({
    documents: linkableDocuments,
    pickerDocuments,
    ...(documentId === null ? {} : { excludeDocumentId: documentId }),
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
    // The SEARCH rides along: this writes the address of the document already
    // loaded, so a bare pathname drops a query the reader arrived with — which
    // is how `?v=` never survived to be read here (ADR-0022's note).
    navigate({ pathname: path, search: location.search }, { replace: isFirstSync })
  }, [documentPath, navigate, location.search])

  useBrowserRouteSync({
    documentId,
    documentPath,
    pathname: location.pathname,
    navigate,
    documentIdOfPath,
    switchDocument,
    documentsEnumeratedRef,
  })

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

  // Who holds the workspace record for THIS document. A markdown note gets no
  // backend at all (see the `backend` memo above), so the hook that owns its
  // doc supplies the seam instead. Named once because two consumers need it —
  // the version controls below, and the automatic checkpoint here, which read
  // `backend` alone until a markdown note turned out to arm no checkpoint ever.
  const recordSource = backend ?? markdownDoc.records

  const checkpointPair = useAutoCheckpoint(recordSource, versionStore, documentPath)

  // Handed to the markdown hook, which has no sync session to ride: a spatial
  // document arms this from `subscribeLocalUpdates`, and a markdown one from
  // its own doc subscription through here.
  checkpointSignalRef.current = checkpointPair.signal

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
    proposals,
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
  // restores through whichever seam holds the live workspace record.
  //
  // Which seam that is follows the KIND, and this is the one line the
  // parity turned on. A version is a frontier of the workspace record, and
  // both kinds live in the same record — but this was built from `backend`
  // alone, which a markdown note deliberately never has, so a note's rows
  // were written by the checkpoint scheduler and reachable by nothing. Null
  // only while nothing is loaded, and then the control is hidden rather
  // than left to fall back onto the daemon's routes.
  const versionsRecord = recordSource
  const versionsBackend = useMemo(
    () =>
      versionsRecord === null
        ? null
        : createBrowserVersionsBackend({
            record: versionsRecord,
            store: versionStore,
            kind: documentKind,
          }),
    [versionsRecord, versionStore, documentKind],
  )

  // Built on the backend, because a branch is a frontier of the record the
  // backend holds and a branch write goes through the same queue its edits
  // do. Mounting it is also what stops a branch consumer on this page falling
  // through to the context's daemon fallback and issuing a request to a
  // daemon that is not there — which was this provider's whole job while the
  // keeper had no branches, and remains true now that it has them.
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
  const conversation = conversationReads(documentKind, markdownDoc, spatialAnnotations, canvas)

  /**
   * The rail's write door. A markdown document is given no BrowserBackend
   * on purpose (see the `backend` memo), so there is no session for a
   * command to travel through: its writes go to the host holding it. A
   * spatial document's writes ride `onChange` like every other edit — one
   * undo step, on the annotation channel. The two doors are not a
   * duplicate: they lead to different documents, and the second exists
   * precisely because the first is closed on a note.
   */
  const spatialWrite = spatialThreadWrite(() => canvas, onChange)
  const threadWrite = documentKind === 'markdown' ? markdownThreadWrite(markdownDoc) : spatialWrite

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
  // The tab's mark. A SPATIAL document keeps its symbol on the canvas
  // envelope, the same bucket the edge-style facet uses; a MARKDOWN one
  // keeps its own in the frontmatter facets, which are no canvas value and
  // so arrive on the session's own `facets` reading.
  // Memoised because the resolver PARSES: a fresh object every render
  // would re-arm the favicon's debounce on every render rather than on
  // a change to the document.
  const documentSymbol = useMemo(
    () => resolveOpenDocumentSymbol({ kind: documentKind, canvas, facets: sync.facets }),
    [documentKind, canvas, sync.facets],
  )
  useDocumentFavicon({
    settingsStore,
    documentId,
    kind: documentKind,
    revision: documentKind === 'markdown' ? markdownDoc.body : canvas,
    readSource: readDocumentOutlineSource,
    status: browserFaviconStatus(storageHealth),
    symbol: documentSymbol,
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

  const resolved = browserTerminalAnswer(renderState, backendError, startFresh)
  const { connections, linkify } = useBrowserConnections({
    index: store,
    loro: resolvedLoro,
    documentId: documentId ?? undefined,
    path: documentPath,
  })
  if ('answer' in resolved) return resolved.answer
  const editing = resolved.editing

  const loadedPath = editing.snapshot.path
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
  const labels = documentLabels(documentId, documentName)

  const model: DocumentPageModel = {
    scopeKey: documentId,
    documentKind,
    srTitle: editing.snapshot.name,
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
      ...documentPropertiesSlot(documentKind, markdownDoc),
      status: persistenceFact,
    },
    threads: { ...conversation, proposals, write: threadWrite },
    files: {
      adapter: BROWSER_FILE_ADAPTER,
      stampOf,
      resolveAlias,
      resolveTitle,
      missingFileRef,
      pickerTargets,
    },
    openDocument: navigateToDocument,
    ...labels,
    commands: {
      provider: { kind: 'browser' },
      canvas: labels.commandCanvas,
      registryKey: documentId,
    },
    versions: browserVersionsSlot({ backend: versionsBackend, workspaceId, path: loadedPath }),
    ...browserConnectionsSlot(connections, navigateToDocument, linkify),
    topBar: {
      // Local mode names documents through its own store, not through the
      // daemon's `/names`, so the identity the bar offers is unused here and
      // `title`/`onTitleChange` stay the source.
      workspaceId: 'local',
      path: loadedPath,
      dataMode: 'local',
      branchRefreshSignal,
      onBranchesChanged: () => setBranchRefreshSignal((n) => n + 1),
      // The way out of the editor. This page had none until now — the
      // app-shell brand mark was the only exit, and it says nothing about
      // where it goes.
      onNavigateBack: () => {
        const handle = browserWorkspaceHandleOrNull()
        navigate(handle === null ? indexPath() : workspacePath(handle))
      },
    },
    spatial: {},
    ...(tagVocabulary === undefined ? {} : { tags: tagVocabulary }),
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
          {/* Spatial only: `canvas` falls back to an empty document on a
              markdown note, so this row would hand back a well-formed file
              whose content is not the note's — under a verb saying it is. */}
          {documentKind === 'spatial' && (
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
          )}
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
        {page}
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
