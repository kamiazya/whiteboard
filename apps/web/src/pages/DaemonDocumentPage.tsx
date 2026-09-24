import type { DocumentBackend } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentPresenceChip } from '../components/AgentPresenceChip.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { spatialThreadWrite } from '../hooks/spatial-thread-write.js'
import { useAgentActivity } from '../hooks/use-agent-activity.js'
import type { CommentsRailWrite } from '../hooks/use-comments-rail.js'
import { useDocumentFavicon } from '../hooks/use-document-favicon.js'
import { useLinkResolution } from '../hooks/use-link-resolution.js'
import type { ReferenceLoader } from '../hooks/use-reference-seams.js'
import { useTagVocabulary } from '../hooks/use-tag-vocabulary.js'
import { useDocumentSync } from '../hooks/useDocumentSync.js'
import { getAppLogger } from '../lib/app-logger.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import { createDaemonFileAdapter } from '../lib/daemon-file-adapter.js'
import { createDaemonFilesSource } from '../lib/daemon-files-source.js'
import { deriveNewDocumentPath } from '../lib/derive-new-document-path.js'
import { resolveOpenDocumentSymbol } from '../lib/document-symbol.js'
import { daemonFaviconStatus } from '../lib/favicon.js'
import { loadedReferenceOf } from '../lib/loaded-reference-of.js'
import { scheduleReplicaPush, scheduleReplicaRefresh } from '../lib/replica-refresh.js'
import { setShellConnection } from '../lib/shell-status-store.js'
import type { SpatialEditorHandle } from '../lib/spatial/editor-handle.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { applyViewportRequest } from '../lib/viewport-request.js'
import { DocumentPage } from './DocumentPage.js'
import {
  daemonConnectionsSlot,
  daemonDocumentLabels,
  daemonEmptyState,
  daemonTerminalAnswer,
  daemonTopBarSlot,
  daemonVersionsSlot,
} from './daemon-document-slots.js'
import { deriveDaemonPageState } from './daemon-page-state.js'
import type {
  DocumentKeeper,
  DocumentKeeperAnswer,
  DocumentKeeperEvents,
} from './document-keeper.js'
import type { DocumentPageModel } from './document-page-model.js'
import { useDaemonConnections } from './use-daemon-connections.js'
import { useDaemonDocumentBackend } from './use-daemon-document-backend.js'
import { useDaemonDocumentController } from './use-daemon-document-controller.js'
import { useDocumentActions } from './use-document-actions.js'

const log = getAppLogger('daemon-document-page')

export interface DaemonDocumentPageProps {
  daemonBaseUrl: string
  workspaceId?: string
  path?: string
  // The daemon credential for this session: a bootstrap token (#wb= flow)
  // or a pairing session token (pairing-grant flow). Feeds both the HTTP
  // side (createDaemonFetch's Authorization header) and the WS upgrade
  // (DaemonBackend's wsToken); when the #wb= flow also seeded
  // window.__WHITEBOARD_DAEMON_TOKEN__, that global wins for the WS.
  token?: string
  // Injectable so tests can avoid real WebSocket networking; production
  // callers rely on the default DaemonBackend + createDaemonFetch wiring.
  createBackend?: (workspaceId: string, path: string, daemonFetch: typeof fetch) => DocumentBackend
  // Wired to WorkspaceTopBar's own "Back to documents" button. Absent
  // (the default) hides that button — callers that own an index view (the
  // daemon gallery) pass this to return there.
  onNavigateBack?: () => void
  // Served by a server-mode keeper from its own origin (ADR-0047): it has no
  // WebSocket and no replica routes, and its data is not this browser's to
  // keep — the session cookie authenticates, so there is no token either.
  serverMode?: boolean
}

/**
 * The daemon keeper: the controller over the daemon's REST routes, the sync
 * session over a WebSocket or SSE backend, the markdown body off that same
 * session, and the daemon's version rows — answered to the shared
 * `DocumentPage` as one model (ADR-0004 decision 2: the controller layer
 * stays capability-selected, the page does not).
 */
function useDaemonDocument(
  {
    daemonBaseUrl,
    workspaceId,
    path,
    token,
    createBackend,
    onNavigateBack,
    serverMode = false,
  }: DaemonDocumentPageProps,
  events: DocumentKeeperEvents,
): DocumentKeeperAnswer {
  // Stable across the page's lifetime: daemonBaseUrl/token come from a fixed
  // pairing payload, so this never needs to change once mounted.
  const daemonFetch = useMemo(() => createDaemonFetch(daemonBaseUrl, token), [daemonBaseUrl, token])
  // This keeper's branches, over the same authorized fetch: the one supplier
  // for the `?v=` preview below and for every consumer under the provider
  // (chip, banner, dialog), so a hosted page paired to a loopback daemon
  // cannot have half of them fall back to its own origin.

  // The WebSocket URL is derived from this locationHref (see
  // buildWhiteboardWsUrl), so it must be the daemon's own origin — a hosted
  // web app paired to a loopback daemon must not open the socket against its
  // own page origin.
  const controller = useDaemonDocumentController({ daemonBaseUrl, workspaceId, path, daemonFetch })

  // ADR-0023's replica reconciliation, both directions, at the moment this
  // browser is working on a daemon workspace. PUSH first (decision 3's
  // return half — offline edits ship as ordinary ops; a clean replica costs
  // one IndexedDB read and no network), THEN the pull refresh, so a
  // merge-back cannot read as an offline edit vanishing between the two.
  // Both modules dedupe internally, so the effect can fire on every resolve.
  useEffect(() => {
    if (controller.workspaceId === null || serverMode) return
    const cancelPush = scheduleReplicaPush({
      fetch: daemonFetch,
      daemonBaseUrl,
      workspaceId: controller.workspaceId,
    })
    const cancelRefresh = scheduleReplicaRefresh({
      fetch: daemonFetch,
      daemonBaseUrl,
      workspaceId: controller.workspaceId,
    })
    // Both are scheduled onto an idle callback or a 1.5s timer, so without
    // this they outlive the page that asked — and fire against a fetch, a
    // daemon address and a workspace that have all moved on. Cancelling is
    // free where the run has already begun (it is left alone to finish) and
    // releases the dedupe where it has not, so the next resolve tries again.
    return () => {
      cancelPush()
      cancelRefresh()
    }
  }, [daemonFetch, daemonBaseUrl, controller.workspaceId, serverMode])

  // Stable across the page's lifetime — read fresh (not cached in state)
  // wherever the current settings are needed.
  const [settingsStore] = useState(() => createUserSettingsStore())

  // The selected (workspaceId, path) pair once both are known, computed once so
  // every downstream guard and child prop shares a single non-null narrowing
  // instead of repeating `workspaceId !== null && path !== null`.
  const canvas =
    controller.workspaceId !== null && controller.path !== null
      ? { workspaceId: controller.workspaceId, path: controller.path }
      : null

  // Disables the empty-state "Create a canvas" control while a create is in
  // flight. `disabled` is the whole mechanism: an in-handler
  // `if (creating) return` reads the render closure, so it is stale in exactly
  // the same-tick double-press case it would have to catch.
  const [creating, setCreating] = useState(false)
  // Bumped on an externally observed HEAD change (another client, an MCP
  // tool call) so HeaderBranchChip refetches; the chip's own switch/create/
  // rename/delete actions already refetch internally and don't need this.
  const [branchRefreshSignal, setBranchRefreshSignal] = useState(0)
  const { backend, contentDocumentId, authError, reportAuthError } = useDaemonDocumentBackend({
    daemonBaseUrl,
    token,
    daemonFetch,
    createBackend,
    workspaceId: controller.workspaceId,
    path: controller.path,
    loading: controller.loading,
    documents: controller.documents,
    serverMode,
  })

  // Holds the mounted SpatialEditor's imperative handle so a daemon-driven
  // viewport_request (see onViewportRequest below) can reach it without
  // useDocumentSync/document-sync-session owning a DOM-facing ref themselves.
  const spatialEditorRef = useRef<SpatialEditorHandle | null>(null)
  // An agent editing this document announces itself; both the chip and the
  // outline lapse on their own, so a crashed agent leaves nothing behind.
  const { state: agentActivity, report: reportAgentActivity } = useAgentActivity()

  const sync = useDocumentSync(backend, {
    ...(contentDocumentId === undefined ? {} : { contentDocumentId }),
    onAuthError: reportAuthError,
    onHeadChanged: () => setBranchRefreshSignal((n) => n + 1),
    // Any version_created broadcast — this page's own save, MCP tool saves,
    // other peers — re-reads the page's history column.
    onVersionCreated: events.onVersionCreated,
    onViewportRequest: (payload) => applyViewportRequest(payload, spatialEditorRef.current),
    onAgentActivity: (payload) => reportAgentActivity(payload),
    identity: canvas ?? undefined,
  })
  const {
    canvas: canvasValue,
    loaded: canvasLoaded,
    onChange,
    markdownBody: syncedMarkdownBody,
    coreFacets,
    setCoreFacets,
    syncStatus,
    readOutlineSource,
    annotations,
    threadMarks,
    proposals,
  } = sync

  // New file nodes store the target's immutable id (ADR-0008: stored
  // references key on ids, so a path rename cannot dangle them); the
  // daemon's read routes stay path-addressed, so refs resolve to the
  // CURRENT path through the live documents list. Read through a ref so the
  // adapter identity survives list refreshes; the lookup itself resolves by
  // membership, never by format — legacy path refs miss it and pass
  // through unchanged.
  const canvasesRef = useRef(controller.documents)
  canvasesRef.current = controller.documents

  const resolveRefPath = useCallback(
    (ref: string) => canvasesRef.current.find((entry) => entry.id === ref)?.path,
    [],
  )

  // A ref that matches NEITHER a live id nor a live path points at a deleted
  // canvas (or one imported from elsewhere): the editor renders it as a quiet
  // "Missing reference" and hides the follow affordances — following would
  // lazily create an empty canvas under the dangling ref. Image refs live in
  // the file store, not the documents list, so they are never "missing" here;
  // undefined while the list has not loaded keeps everything ordinary.

  const fileAdapter = useMemo(
    () =>
      createDaemonFileAdapter({
        daemonFetch,
        daemonBaseUrl,
        workspaceId: canvas?.workspaceId ?? '',
        path: canvas?.path ?? '',
        resolveRefPath,
      }),
    [daemonFetch, daemonBaseUrl, canvas?.workspaceId, canvas?.path, resolveRefPath],
  )

  // Undefined until the list names a row for this path — a refresh in flight
  // leaves it so, which both the picker's exclusion and the backlinks fetch
  // read as "not yet".
  const currentDocumentId = controller.documents.find((d) => d.path === controller.path)?.id

  // `[[path]]` aliases resolve against the same list the user can see;
  // display names are retired from resolution and label the link at render
  // time instead (`resolveTitle`). All four derivations are the shared hook's
  // — a summary is already a `LinkableDocument`, so this page passes the list
  // as it stands.
  const { resolveAlias, resolveTitle, missingFileRef, pickerTargets } = useLinkResolution({
    documents: controller.documents,
    excludeDocumentId: currentDocumentId,
  })
  // Canvas embeds (J5a) and image nodes (J5b) read the daemon's own file and
  // snapshot routes. The staleness stamp is the referenced canvas's
  // updatedAt, exactly as in browser mode — keyed by BOTH id and path so id
  // refs and legacy path refs each find theirs.
  const stampOf = useMemo(
    () =>
      new Map(
        controller.documents.flatMap((entry) => [
          [entry.path, entry.updatedAt ?? ''] as const,
          ...(entry.id ? [[entry.id, entry.updatedAt ?? ''] as const] : []),
        ]),
      ),
    [controller.documents],
  )

  // The open document's kind, from the documents list summary (default
  // 'spatial'). It picks which editor DocumentEditorSurface mounts — the
  // page itself no longer chooses an editor.
  const documentKind: DocumentKind =
    controller.documents.find((entry) => entry.path === controller.path)?.kind ?? 'spatial'

  const documentActions = useDocumentActions({
    documentId: currentDocumentId,
    documentKind,
    // Spatial only: `canvasValue` falls back to an empty document on a
    // markdown note, so the row would hand back a well-formed file whose
    // content is not the note's — under a verb saying it is.
    canvas: documentKind === 'spatial' ? canvasValue : null,
    duplicateDocument: controller.duplicateDocument,
    deleteDocument: controller.deleteDocument,
    deleteCopyId: 'delete-document-daemon',
  })

  // SCOPE RESET — see scoped-screen-state.test.ts. Nothing is reset HERE any
  // more, and that is the state to keep: the history column, the save outcome
  // and the comments rail clear themselves inside DocumentPage; the `?v=`
  // view and its notice likewise, which also strips the param a switch leaves
  // naming nothing; and the backlinks clear inside `useDaemonConnections`,
  // which owns them. A new piece of screen-scoped state adds its reset to the
  // hook that owns it, not to a second list here.

  // A markdown document's body lives in the doc's `body` text container —
  // the one place it is stored, and the shape `wb_document_set` writes. The
  // read comes from the sync session (which republishes it on hydration,
  // remote import and undo alike) and the write travels the session's
  // ordinary command path, so a body edit gets the same debounce, undo step
  // and local-update forwarding as every other change, with no second write
  // pipeline. `set-body` carries the WHOLE body, so it needs no canvas: the
  // value passed alongside is the unchanged one this command does not touch.
  const canvasValueRef = useRef(canvasValue)
  canvasValueRef.current = canvasValue
  const setMarkdownBody = useCallback(
    (next: string) => {
      onChange(canvasValueRef.current, { kind: 'set-body', text: next })
    },
    [onChange],
  )
  const markdownBody = documentKind === 'markdown' && canvasLoaded ? syncedMarkdownBody : null

  // The rail's write door: both writes ride `onChange` like every other
  // edit here — one undo step, and they travel the annotation channel back.
  // Through the reducer, not past it. This read "the CURRENT one unchanged:
  // neither write touches a node or an edge" — true of nodes and edges and
  // false of the picture: a status projects onto the flat comment's
  // `resolved` and a new thread projects a pin, so handing the canvas back
  // unchanged left a resolved bubble drawn until a reload and a reopened
  // one invisible for good.
  const threadWrite: CommentsRailWrite = spatialThreadWrite(() => canvasValueRef.current, onChange)

  // Backlinks for the Connections chip, keyed on the CURRENT document's id.
  const { connections, refresh: refreshConnections } = useDaemonConnections({
    daemonFetch,
    daemonBaseUrl,
    workspaceId: controller.workspaceId,
    documentId: currentDocumentId,
    path: controller.path,
  })
  const loadReference = useCallback<ReferenceLoader>(
    async (target, documentId) => {
      // The adapter resolves a legacy path reference itself, so the target
      // as written is what it takes when the list knew no id for it.
      const loaded = await fileAdapter.loadDocument(documentId ?? target)
      if (loaded === undefined) return undefined
      // No name. A document's name is the workspace's (ADR-0009 decision 2)
      // and the daemon summary carries no display name, so there is none to
      // label the embed with — the facets deliberately no longer hold one.
      // The summary DOES carry the kind, which decides what the target is.
      return loadedReferenceOf(loaded, controller.documents, target, documentId)
    },
    [fileAdapter, controller.documents],
  )

  // Tab favicon: sync state as the status dot, scene content as the minimap.
  // The tab's mark. A SPATIAL document keeps its symbol on the canvas
  // envelope, the same bucket the edge-style facet uses; a MARKDOWN one
  // keeps its own in the frontmatter facets, which are no canvas value and
  // so arrive on the session's own `facets` reading.
  // Memoised because the resolver PARSES: a fresh object every render
  // would re-arm the favicon's debounce on every render rather than on
  // a change to the document.
  const documentSymbol = useMemo(
    () =>
      resolveOpenDocumentSymbol({ kind: documentKind, canvas: canvasValue, facets: sync.facets }),
    [documentKind, canvasValue, sync.facets],
  )
  useDocumentFavicon({
    settingsStore,
    documentId: contentDocumentId ?? null,
    kind: documentKind,
    revision: documentKind === 'markdown' ? markdownBody : canvasValue,
    readSource: readOutlineSource,
    status: daemonFaviconStatus({ authError, syncStatus }),
    symbol: documentSymbol,
  })

  // The connection is app-level, so the App-mounted shell draws it and this
  // page only reports what it knows. Synced is claimed only while the session
  // is actually connected: an auth rejection outranks everything else because
  // re-pairing is the only way out of it, and `idle` (not started yet) and
  // `error` fold in with `reconnecting`, whose copy makes no claim about
  // recovery timing. Cleared on unmount — an index page has no live session,
  // and a latched chip would keep claiming one.
  useEffect(() => {
    setShellConnection({
      state: {
        keeper: 'daemon',
        session: authError ? 'sync-off' : syncStatus === 'connected' ? 'synced' : 'reconnecting',
      },
      daemonBaseUrl,
    })
    return () => setShellConnection(null)
  }, [authError, syncStatus, daemonBaseUrl])

  // Creation is immediate — no name is collected up front (ADR-0006 point 3).
  // The path is derived from the loaded documents so it never collides with one
  // already in this workspace; naming happens afterwards in the canvas's top bar.
  const handleCreateDocument = async (): Promise<void> => {
    setCreating(true)
    try {
      await controller.createDocument(
        deriveNewDocumentPath(controller.documents.map((c) => c.path)),
      )
    } finally {
      setCreating(false)
    }
  }

  // The page-level render state, derived once (see daemon-page-state.ts for
  // the cascade's invariants). Terminal states render from THIS, never from
  // ad-hoc controller-field checks in the JSX — the machine is shared with
  // BrowserDocumentPage (document-page-state.ts), so the two pages' state
  // vocabularies cannot drift apart silently.
  // The workspace's tag vocabulary for every tag row and the board's colour
  // by intent (ADR-0040 decision 5): read through the same files source the
  // document browser uses, once per workspace.
  const tagsWorkspaceId = canvas?.workspaceId
  const tagsSource = useMemo(
    () =>
      tagsWorkspaceId === undefined
        ? null
        : createDaemonFilesSource(daemonFetch, daemonBaseUrl, tagsWorkspaceId),
    [daemonFetch, daemonBaseUrl, tagsWorkspaceId],
  )
  const tagVocabulary = useTagVocabulary(tagsSource)

  const pageState = deriveDaemonPageState({
    loading: controller.loading,
    loadError: controller.loadError,
    canvas,
    documentCount: controller.documents.length,
    // The path is LISTED, which is a different question from whether this
    // connection syncs its content — an injected backend keeps the
    // per-document contract and carries no content id at all.
    documentAtPath: controller.documents.some((entry) => entry.path === controller.path),
    refusal: controller.refusal,
  })

  const terminal = daemonTerminalAnswer(pageState, daemonBaseUrl, controller.retry)
  if (terminal !== null) return terminal

  const labels = daemonDocumentLabels(canvas)
  const { documentKey } = labels
  const openDocument = (id: string) => controller.switchDocument(resolveRefPath(id) ?? id)

  const emptyState = daemonEmptyState({
    pageState,
    onNavigateBack,
    createError: controller.createError,
    creating,
    setCreating,
    createDocument: controller.createDocument,
    handleCreateDocument,
  })

  const model: DocumentPageModel = {
    scopeKey: labels.scopeKey,
    documentKey,
    documentKind,
    srTitle: 'Whiteboard (daemon)',
    sync,
    markdown: {
      body: markdownBody,
      setBody: setMarkdownBody,
      meta: coreFacets ?? { type: documentKind },
      hydrating: false,
    },
    // The NAME is the workspace's — the top bar hands it down from `/names`,
    // the same surface the canvas dropdown renames through.
    title: 'top-bar',
    properties: {
      ready: true,
      // Facets are OKF frontmatter, so only a markdown document has any —
      // `readCoreFacets` answers `undefined` for a spatial one (ADR-0009
      // decision 3), which is what decides the disclosure without a second
      // flag to keep in sync.
      ...(coreFacets === undefined ? {} : { facets: coreFacets }),
      onFacetsChange: setCoreFacets,
    },
    threads: {
      annotations,
      proposals,
      threadMarks,
      write: threadWrite,
      railCanvas: canvasValue,
    },
    files: {
      adapter: fileAdapter,
      stampOf,
      resolveAlias,
      resolveTitle,
      missingFileRef,
      pickerTargets,
      loadReference,
    },
    openDocument,
    overlayTitle: labels.overlayTitle,
    exportFilenameBase: labels.exportFilenameBase,
    commands: {
      provider: { kind: 'daemon', daemonBaseUrl },
      // The daemon canvas summary carries no display name yet (only
      // path/updatedAt) — the path doubles as `name` until that changes.
      canvas: labels.commandCanvas,
      // Identity key = workspaceId+path, matching this page's own canvas.
      registryKey: labels.registryKey,
    },
    versions: daemonVersionsSlot({
      canvas,
      labels,
      daemonFetch,
      daemonBaseUrl,
      log,
      onVersionCreated: events.onVersionCreated,
    }),
    topBar: daemonTopBarSlot(canvas, branchRefreshSignal, setBranchRefreshSignal, onNavigateBack),
    spatial: {
      editorRef: spatialEditorRef,
      agentTouchedNodeIds: agentActivity.touchedNodeIds,
      children: <AgentPresenceChip summary={agentActivity.summary} />,
    },
    ...(tagVocabulary === undefined ? {} : { tags: tagVocabulary }),
    ...daemonConnectionsSlot({
      canvas,
      connections,
      workspaceId: controller.workspaceId,
      currentDocumentId,
      switchDocument: controller.switchDocument,
      daemonFetch,
      daemonBaseUrl,
      refreshConnections,
    }),
    slots: {
      ...(emptyState === undefined ? {} : { replaceEditor: emptyState }),
      ...documentActions,
    },
  }

  return {
    kind: 'render',
    model,
    wrap: (page: ReactNode) => (
      <DaemonApiContext.Provider value={daemonFetch}>{page}</DaemonApiContext.Provider>
    ),
  }
}

export const daemonKeeper: DocumentKeeper<DaemonDocumentPageProps> = {
  kind: 'daemon',
  useDocument: useDaemonDocument,
}

/** The shared page, bound to the daemon keeper — what App mounts under a daemon's routes. */
export function DaemonDocumentPage(props: DaemonDocumentPageProps) {
  return <DocumentPage keeper={daemonKeeper} props={props} />
}
