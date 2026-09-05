import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import {
  documentsApiUrl,
  saveVersionResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { DaemonBackend } from '@kamiazya/whiteboard-daemon-client/daemon-backend'
import type { DocumentBackend } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { selectDocumentTransport } from '@kamiazya/whiteboard-daemon-client/select-document-transport'
import { SseBackend } from '@kamiazya/whiteboard-daemon-client/sse-backend'
import { type DocumentKind, isImageRef } from '@kamiazya/whiteboard-model'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AgentPresenceChip } from '../components/AgentPresenceChip.js'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import type { ConnectionsBacklink } from '../components/connections/ConnectionsChip.js'
import { ConnectionsChip } from '../components/connections/ConnectionsChip.js'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { LoadDegradedView } from '../components/document-editor/LoadDegradedView.js'
import { HeaderBranchBanner } from '../components/HeaderBranchBanner.js'
import { HeaderVariationBanner } from '../components/HeaderVariationBanner.js'
import { MergeToast } from '../components/MergeToast.js'
import { Button } from '../components/ui/button.js'
import { DAEMON_HISTORY_CAPABILITIES } from '../components/VersionTimeline'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useVersionsBackend } from '../contexts/VersionsBackendContext.js'
import { useAgentActivity } from '../hooks/use-agent-activity.js'
import type { CommentsRailWrite } from '../hooks/use-comments-rail.js'
import { useDocumentFavicon } from '../hooks/use-document-favicon.js'
import type { ReferenceLoader } from '../hooks/use-reference-seams.js'
import { dispatchIdentityEvent, useDocumentSync } from '../hooks/useDocumentSync.js'
import { getAppLogger } from '../lib/app-logger.js'
import { type BranchMeta, branchesApi } from '../lib/branches-backend.js'
import {
  createDaemonFetch,
  getDocumentBacklinks,
  linkifyDocumentMentions,
} from '../lib/daemon-api-client.js'
import { createDaemonFileAdapter } from '../lib/daemon-file-adapter.js'
import { deriveNewDocumentPath } from '../lib/derive-new-document-path.js'
import { devTransportOverride } from '../lib/dev-transport-override.js'
import { daemonFaviconStatus } from '../lib/favicon.js'
import { linkEntries, linkTargets, linkTitles } from '../lib/link-entries.js'
import { loadedReferenceOf } from '../lib/loaded-reference-of.js'
import { DAEMON_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { scheduleReplicaPush, scheduleReplicaRefresh } from '../lib/replica-refresh.js'
import { setShellConnection } from '../lib/shell-status-store.js'
import type { SpatialEditorHandle } from '../lib/spatial/editor-handle.js'
import { createSharedSseStreamSource } from '../lib/sse-shared-stream-source.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import type { PastDocument } from '../lib/versions-backend.js'
import { applyViewportRequest } from '../lib/viewport-request.js'
import { DocumentPage } from './DocumentPage.js'
import { deriveDaemonPageState } from './daemon-page-state.js'
import type {
  DocumentKeeper,
  DocumentKeeperAnswer,
  DocumentKeeperEvents,
} from './document-keeper.js'
import type { DocumentPageModel } from './document-page-model.js'
import { useDaemonDocumentController } from './use-daemon-document-controller.js'

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
  capabilities?: WhiteboardCapabilities
  // Injectable so tests can avoid real WebSocket networking; production
  // callers rely on the default DaemonBackend + createDaemonFetch wiring.
  createBackend?: (workspaceId: string, path: string, daemonFetch: typeof fetch) => DocumentBackend
  // Wired to WorkspaceTopBar's own "Back to documents" button. Absent
  // (the default) hides that button — callers that own an index view (the
  // daemon gallery) pass this to return there.
  onNavigateBack?: () => void
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
    capabilities = DAEMON_CAPABILITIES,
    createBackend,
    onNavigateBack,
  }: DaemonDocumentPageProps,
  events: DocumentKeeperEvents,
): DocumentKeeperAnswer {
  // Stable across the page's lifetime: daemonBaseUrl/token come from a fixed
  // pairing payload, so this never needs to change once mounted.
  const daemonFetch = useMemo(() => createDaemonFetch(daemonBaseUrl, token), [daemonBaseUrl, token])

  // The WebSocket URL is derived from this locationHref (see
  // buildWhiteboardWsUrl), so it must be the daemon's own origin — a hosted
  // web app paired to a loopback daemon must not open the socket against its
  // own page origin.
  // The injected factory is held in a ref rather than carried in the backend
  // memo's dependencies: it customises HOW a connection is built, it does not
  // say WHICH connection this is. A parent writing the natural
  // `createBackend={(w, s) => …}` hands this page a new function identity on
  // every one of its own renders, and anything the backend memo depends on
  // becomes the session's lifetime — so that alone would tear down the
  // socket, re-hydrate, and drop the undo history for a canvas the user
  // never left. Only values that define the connection belong in those deps.
  const createBackendRef = useRef(createBackend)
  createBackendRef.current = createBackend

  const controller = useDaemonDocumentController({ daemonBaseUrl, workspaceId, path, daemonFetch })

  // ADR-0023's replica reconciliation, both directions, at the moment this
  // browser is working on a daemon workspace. PUSH first (decision 3's
  // return half — offline edits ship as ordinary ops; a clean replica costs
  // one IndexedDB read and no network), THEN the pull refresh, so a
  // merge-back cannot read as an offline edit vanishing between the two.
  // Both modules dedupe internally, so the effect can fire on every resolve.
  useEffect(() => {
    if (controller.workspaceId === null) return
    scheduleReplicaPush({
      fetch: daemonFetch,
      daemonBaseUrl,
      workspaceId: controller.workspaceId,
    })
    scheduleReplicaRefresh({
      fetch: daemonFetch,
      daemonBaseUrl,
      workspaceId: controller.workspaceId,
    })
  }, [daemonFetch, daemonBaseUrl, controller.workspaceId])

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

  const [authError, setAuthError] = useState(false)
  // Disables the empty-state "Create a canvas" control while a create is in
  // flight. `disabled` is the whole mechanism: an in-handler
  // `if (creating) return` reads the render closure, so it is stale in exactly
  // the same-tick double-press case it would have to catch.
  const [creating, setCreating] = useState(false)
  // Bumped on an externally observed HEAD change (another client, an MCP
  // tool call) so HeaderBranchChip refetches; the chip's own switch/create/
  // rename/delete actions already refetch internally and don't need this.
  const [branchRefreshSignal, setBranchRefreshSignal] = useState(0)
  // ── ?v=<name>: a non-default variation, addressable (ADR-0022) ──
  // The address names a READ-ONLY view of that variation's tip; HEAD does
  // not move. Decision 1 holds on both edges: `?v=main` and a `?v` naming
  // the current HEAD strip back to the plain address, so the default
  // variation is never decorated.
  const [searchParams, setSearchParams] = useSearchParams()
  const variationParam = searchParams.get('v')
  const [variationPreview, setVariationPreview] = useState<{
    name: string
    head: string
    branches: readonly BranchMeta[]
    past: PastDocument
  } | null>(null)
  const [variationNotice, setVariationNotice] = useState<string | null>(null)
  const clearVariationParam = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('v')
        return next
      },
      { replace: true },
    )
  }, [setSearchParams])

  useEffect(() => {
    if (!canvas || variationParam === null || !capabilities.branches) {
      setVariationPreview(null)
      return
    }
    const { workspaceId: wsId, path: docPath } = canvas
    let cancelled = false
    const api = branchesApi(wsId, docPath, daemonFetch)
    void (async () => {
      try {
        const state = await api.list()
        if (cancelled) return
        if (variationParam === 'main' || variationParam === state.head) {
          clearVariationParam()
          return
        }
        if (!state.branches.some((b) => b.name === variationParam)) {
          setVariationNotice(`Variation «${variationParam}» was not found`)
          clearVariationParam()
          return
        }
        const past = await api.loadDocument(variationParam)
        if (cancelled) return
        if (past === null) {
          setVariationNotice(`Variation «${variationParam}» could not be read`)
          clearVariationParam()
          return
        }
        setVariationNotice(null)
        setVariationPreview({
          name: variationParam,
          head: state.head,
          branches: state.branches,
          past,
        })
      } catch {
        if (!cancelled) {
          setVariationNotice('Variation preview failed to load')
          clearVariationParam()
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // branchRefreshSignal: an external HEAD change can make the previewed
    // name the HEAD, which must strip the param rather than keep a stale
    // "read-only" claim over what is now the live document.
  }, [
    canvas?.workspaceId,
    canvas?.path,
    variationParam,
    capabilities.branches,
    daemonFetch,
    clearVariationParam,
    branchRefreshSignal,
  ])

  const switchToVariation = useCallback(() => {
    if (!canvas || variationPreview === null) return
    const { workspaceId: wsId, path: docPath } = canvas
    void (async () => {
      try {
        await branchesApi(wsId, docPath, daemonFetch).setHead(variationPreview.name)
        setBranchRefreshSignal((n) => n + 1)
        clearVariationParam()
      } catch {
        setVariationNotice('Switching to this variation failed')
      }
    })()
  }, [canvas, variationPreview, daemonFetch, clearVariationParam])

  // Every listed document is tree-served and syncs at workspace-document
  // granularity; the id is what binds this session's content inside the
  // workspace record. Derived as a plain string so a summary refresh that
  // changes only updatedAt cannot flip the backend identity. Undefined only
  // while the path is absent from the list (a stale URL).
  const workspaceSyncDocumentId = useMemo(() => {
    const entry = controller.documents.find((d) => d.path === controller.path)
    return entry?.id
  }, [controller.documents, controller.path])

  // Backend identity is keyed on (workspaceId, path, daemonFetch, sync
  // granularity) — a change to any of these tears down the old connection and
  // opens a new one via useDocumentSync's own effect cleanup (see
  // BrowserDocumentPage for the same ownership split: this hook only decides
  // WHEN to swap identity, not how disconnect/connect ordering happens).
  // `contentDocumentId` travels WITH the backend because they only make sense
  // together: an injected backend (tests, embedders) keeps the per-document
  // contract, so scoping the session against its snapshot would misread it.
  const backendState = useMemo((): {
    backend: DocumentBackend
    contentDocumentId: string | undefined
  } | null => {
    if (controller.workspaceId === null || controller.path === null) return null
    // No backend until the initial documents list is in: the page renders a
    // skeleton anyway, and the list is what decides the sync granularity —
    // connecting before it loads would open a per-document socket only to
    // tear it down and reconnect at workspace scope a moment later.
    if (controller.loading) return null
    const injected = createBackendRef.current?.(
      controller.workspaceId,
      controller.path,
      daemonFetch,
    )
    if (injected) return { backend: injected, contentDocumentId: undefined }
    // Nothing is at this path (a stale URL — the document was deleted or
    // never existed): no connection. The per-document contract used to catch
    // this with a lazily created empty doc, which silently minted a blank
    // canvas at the old path on the first edit; creating a document is an
    // explicit act now (see the not-found state below).
    if (workspaceSyncDocumentId === undefined) return null
    // A secure page cannot open a ws:// socket to an http daemon at all, so
    // the transport is decided up front rather than attempted and retried.
    //
    // The override in front is development-only and compiles away entirely
    // in a production build. It exists because the rule below is correct AND
    // makes the SSE path — and the SharedWorker behind it — unreachable from
    // `pnpm dev`, which serves plain http.
    const transport =
      devTransportOverride() ??
      selectDocumentTransport({
        pageOrigin: window.location.origin,
        daemonBaseUrl,
      })
    if (transport !== 'sse') {
      // wsToken carries the pairing session token into the WS upgrade —
      // without it a pairing-grant session authenticates HTTP but opens
      // the socket credential-less and is rejected 401 (edits then stay
      // browser-only while the page looks connected).
      return {
        backend: new DaemonBackend(controller.workspaceId, controller.path, daemonBaseUrl, {
          fetch: daemonFetch,
          wsToken: () => token,
        }),
        contentDocumentId: workspaceSyncDocumentId,
      }
    }
    // Null where SharedWorker is unavailable; SseBackend then opens its own
    // stream, which is correct but not shared across tabs. Same granularity
    // as the WebSocket branch: every document syncs at workspace-document
    // granularity.
    const shared = createSharedSseStreamSource(daemonBaseUrl, token) ?? undefined
    return {
      backend: new SseBackend(
        controller.workspaceId,
        controller.path,
        daemonBaseUrl,
        { fetch: daemonFetch },
        shared,
      ),
      contentDocumentId: workspaceSyncDocumentId,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    controller.workspaceId,
    controller.path,
    controller.loading,
    daemonFetch,
    daemonBaseUrl,
    token,
    workspaceSyncDocumentId,
  ])
  const backend = backendState?.backend ?? null

  // A rejected session belongs to one backend identity — switching to a new
  // canvas opens a fresh connection, so a stale banner must not outlive the
  // backend that produced it. Only resets on a genuine new (non-null)
  // connection: dropping to no backend at all (e.g. switching into a
  // workspace with zero documents) leaves authError as-is, because live sync
  // is still off either way and the persistent indicator should stay lit.
  useEffect(() => {
    if (backend) setAuthError(false)
  }, [backend])

  // Holds the mounted SpatialEditor's imperative handle so a daemon-driven
  // viewport_request (see onViewportRequest below) can reach it without
  // useDocumentSync/document-sync-session owning a DOM-facing ref themselves.
  const spatialEditorRef = useRef<SpatialEditorHandle | null>(null)
  // An agent editing this document announces itself; both the chip and the
  // outline lapse on their own, so a crashed agent leaves nothing behind.
  const { state: agentActivity, report: reportAgentActivity } = useAgentActivity()

  const sync = useDocumentSync(backend, {
    ...(backendState?.contentDocumentId === undefined
      ? {}
      : { contentDocumentId: backendState.contentDocumentId }),
    onAuthError: () => setAuthError(true),
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
    clearLocalUndo,
    markdownBody: syncedMarkdownBody,
    coreFacets,
    setCoreFacets,
    syncStatus,
    readOutlineSource,
    annotations,
    threadMarks,
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
  const missingFileRef = useMemo(() => {
    const entries = controller.documents
    if (entries.length === 0) return undefined
    const known = new Set(entries.flatMap((entry) => [entry.path, ...(entry.id ? [entry.id] : [])]))
    return (ref: string) => !isImageRef(ref) && !known.has(ref)
  }, [controller.documents])

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

  // `[[path]]` aliases resolve against the same list the user can see;
  // display names are retired from resolution and label the link at render
  // time instead (`resolveTitle`).
  const resolveTitle = useMemo(() => linkTitles(controller.documents), [controller.documents])
  const resolveAlias = useMemo(
    () => createUniqueNameResolver(linkEntries(controller.documents)),
    [controller.documents],
  )
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

  // SCOPE RESET — see scoped-screen-state.test.ts. The history column, the
  // save outcome and the comments rail clear themselves inside DocumentPage,
  // keyed on the same document this effect watches.
  useEffect(() => {
    // The variation view and its message are about the DEPARTED document.
    // `?v` is not stripped by a switch — `switchDocument` sets the path and
    // nothing else — so the effect below re-resolves the same name against
    // the ARRIVED document, and until it answers the previous document's
    // preview is on screen under the new one's name. The notice is worse: no
    // branch of that effect clears it, so `Variation «x» was not found`
    // about one document outlives it onto the next.
    setVariationPreview(null)
    setVariationNotice(null)
    // Backlinks OF this document. The fetch below nulls them itself, but only
    // once it knows the arrived document's id — which comes from a list that
    // may still be refreshing, so the departed document's connections would
    // be listed under the arrived one until it does.
    setConnections(null)
  }, [controller.path])

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
  // The canvas argument is the CURRENT one unchanged: neither write touches
  // a node or an edge, which is why the commands have their own write path.
  const threadWrite: CommentsRailWrite = {
    createThread: (thread) => onChange(canvasValueRef.current, { kind: 'create-thread', thread }),
    replyToThread: (threadId, message) =>
      onChange(canvasValueRef.current, { kind: 'reply-to-thread', threadId, message }),
    setThreadStatus: (threadId, status) =>
      onChange(canvasValueRef.current, { kind: 'set-thread-status', threadId, status }),
    editMessage: (threadId, message, opening) =>
      onChange(canvasValueRef.current, {
        kind: 'edit-thread-message',
        threadId,
        message,
        opening,
      }),
  }

  // The same list, one row per document, carried with ids so the picker can
  // fall back to one when a name is ambiguous.
  const pickerTargets = useMemo(
    () =>
      linkTargets(controller.documents, {
        excludeDocumentId: controller.documents.find((d) => d.path === controller.path)?.id,
      }),
    [controller.documents, controller.path],
  )

  // Backlinks for the Connections chip. Keyed on the CURRENT document's id —
  // an older daemon's id-less listing leaves it undefined and the chip
  // disabled rather than querying with a path the route would reject.
  const currentDocumentId = controller.documents.find((d) => d.path === controller.path)?.id
  const [connections, setConnections] = useState<{
    readonly backlinks: readonly ConnectionsBacklink[]
    readonly unlinkedMentions: readonly ConnectionsBacklink[]
  } | null>(null)
  const [connectionsRefresh, setConnectionsRefresh] = useState(0)
  useEffect(() => {
    setConnections(null)
    if (currentDocumentId === undefined || controller.workspaceId === null) return
    let cancelled = false
    getDocumentBacklinks(daemonFetch, daemonBaseUrl, controller.workspaceId, currentDocumentId)
      .then((response) => {
        if (!cancelled) setConnections(response)
      })
      .catch(() => {
        // The chip simply stays disabled; connections are never worth an
        // error surface of their own on a page that otherwise works.
      })
    return () => {
      cancelled = true
    }
  }, [daemonFetch, daemonBaseUrl, controller.workspaceId, currentDocumentId, connectionsRefresh])
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
  useDocumentFavicon({
    settingsStore,
    documentId: backendState?.contentDocumentId ?? null,
    kind: documentKind,
    revision: documentKind === 'markdown' ? markdownBody : canvasValue,
    readSource: readOutlineSource,
    status: daemonFaviconStatus({ authError, syncStatus }),
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

  // The keeper this page's history belongs to. No provider is mounted here,
  // so this is the daemon backend over `DaemonApiContext`'s fetch — the
  // picture rides to the same route it always did, by the seam both pages
  // share rather than by a URL only this one could build.
  const versionsBackend = useVersionsBackend()

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
  const pageState = deriveDaemonPageState({
    loading: controller.loading,
    loadError: controller.loadError,
    canvas,
    documentCount: controller.documents.length,
    documentAtPath: workspaceSyncDocumentId !== undefined,
  })

  if (pageState.kind === 'loading') {
    return { kind: 'terminal', node: <DocumentPageSkeleton label="Connecting to daemon" /> }
  }

  if (pageState.kind === 'load-degraded') {
    return { kind: 'terminal', node: <LoadDegradedView message={pageState.message} /> }
  }

  const documentKey = canvas ? `${canvas.workspaceId}/${canvas.path}` : 'no-canvas'
  const openDocument = (id: string) => controller.switchDocument(resolveRefPath(id) ?? id)

  const emptyState =
    pageState.kind === 'document-missing' ? (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
        {onNavigateBack && (
          <button
            type="button"
            onClick={onNavigateBack}
            className="self-start rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span aria-hidden="true">← </span>Back to documents
          </button>
        )}
        <p className="text-sm text-muted-foreground">
          Nothing is at <span className="font-medium text-foreground">“{pageState.path}”</span> in
          this workspace. It may have been deleted or renamed.
        </p>
        {controller.createError && (
          <div role="alert" aria-live="assertive" className="text-xs text-destructive">
            {controller.createError}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={creating}
          onClick={() => {
            setCreating(true)
            void controller.createDocument(pageState.path).finally(() => setCreating(false))
          }}
        >
          Create a canvas at this path
        </Button>
      </div>
    ) : pageState.kind === 'workspace-empty' ? (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
        {/* WorkspaceTopBar (the usual home for this button) only mounts once
            a canvas is selected, so a workspace that resolves to zero
            documents — an empty workspace, or a gallery row whose canvas was
            deleted by another client — needs its own back affordance here. */}
        {onNavigateBack && (
          <button
            type="button"
            onClick={onNavigateBack}
            className="self-start rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span aria-hidden="true">← </span>Back to documents
          </button>
        )}
        <p className="text-sm text-muted-foreground">This workspace has no documents yet.</p>
        {controller.createError && (
          <div role="alert" aria-live="assertive" className="text-xs text-destructive">
            {controller.createError}
          </div>
        )}
        {/* An empty state is a reading surface, not a dense toolbar strip
            (ADR-0006 point 4), so the control keeps its text label rather
            than becoming an icon-only "+". */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={creating}
          onClick={() => void handleCreateDocument()}
        >
          Create a canvas
        </Button>
      </div>
    ) : undefined

  const model: DocumentPageModel = {
    scopeKey: canvas ? `${canvas.workspaceId}:${canvas.path}` : null,
    documentKey,
    documentKind,
    srTitle: 'Whiteboard (daemon)',
    capabilities,
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
    threads: { annotations, threadMarks, write: threadWrite, railCanvas: canvasValue },
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
    overlayTitle: canvas?.path ?? 'Untitled',
    exportFilenameBase: canvas?.path ?? 'canvas',
    commands: {
      provider: { kind: 'daemon', daemonBaseUrl, capabilities },
      // The daemon canvas summary carries no display name yet (only
      // path/updatedAt) — the path doubles as `name` until that changes.
      canvas:
        canvas !== null
          ? { workspaceId: canvas.workspaceId, documentId: canvas.path, name: canvas.path }
          : null,
      // Identity key = workspaceId+path, matching this page's own canvas.
      registryKey: canvas !== null ? `${canvas.workspaceId}/${canvas.path}` : null,
    },
    versions: {
      enabled: canvas !== null,
      workspaceId: canvas?.workspaceId ?? '',
      path: canvas?.path ?? '',
      historyCapabilities: DAEMON_HISTORY_CAPABILITIES,
      backend: versionsBackend,
      save: async (label) => {
        if (canvas === null) throw new Error('saveVersion: no canvas')
        const res = await daemonFetch(
          `${daemonBaseUrl}${documentsApiUrl(canvas.workspaceId, canvas.path, 'versions')}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label }),
          },
        )
        if (!res.ok) throw new Error(`save failed: ${res.status}`)
        const parsed = saveVersionResponseSchema.safeParse(await res.json().catch(() => null))
        if (!parsed.success) {
          log.error(
            'POST /versions response did not match saveVersionResponseSchema:',
            parsed.error,
          )
          throw new Error('save response did not match schema')
        }
        return {
          workspaceId: canvas.workspaceId,
          path: canvas.path,
          versionId: parsed.data.version.id,
        }
      },
      announceRefresh: events.onVersionCreated,
      // The server's manual POST /versions route does not broadcast
      // version_created over the websocket (that only fires for auto-saves
      // and other peers' saves), so this save must dispatch the same
      // identity-scoped event useDocumentSync fires on a broadcast — otherwise
      // nothing listening for the save (the version list, the tab) learns it happened.
      announceOnce: () => dispatchIdentityEvent('whiteboard:wb_version_saved', canvas ?? undefined),
    },
    topBar: canvas
      ? {
          workspaceId: canvas.workspaceId,
          path: canvas.path,
          branchRefreshSignal,
          onPreviewVariation: (name) => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev)
              next.set('v', name)
              return next
            })
          },
          ...(onNavigateBack === undefined ? {} : { onNavigateBack }),
        }
      : null,
    readOnlyPast: variationPreview?.past ?? null,
    spatial: {
      editorRef: spatialEditorRef,
      agentTouchedNodeIds: agentActivity.touchedNodeIds,
      children: <AgentPresenceChip summary={agentActivity.summary} />,
    },
    slots: {
      afterTitle: canvas && (
        <ConnectionsChip
          backlinks={connections === null ? null : connections.backlinks}
          mentions={connections?.unlinkedMentions}
          onOpen={(entry) => controller.switchDocument(entry.path)}
          onLinkify={(mention) => {
            if (controller.workspaceId === null || currentDocumentId === undefined) return
            void linkifyDocumentMentions(
              daemonFetch,
              daemonBaseUrl,
              controller.workspaceId,
              mention.documentId,
              currentDocumentId,
            )
              .then(() => setConnectionsRefresh((n) => n + 1))
              .catch(() => {
                // The panel simply keeps showing the mention; the
                // next open retries.
              })
          }}
        />
      ),
      headerExtras: (
        <>
          {capabilities.branches && canvas && variationPreview !== null && (
            <HeaderVariationBanner
              workspaceId={canvas.workspaceId}
              path={canvas.path}
              name={variationPreview.name}
              head={variationPreview.head}
              branches={variationPreview.branches}
              onSwitch={switchToVariation}
              onExit={clearVariationParam}
              runMerge={(src, args) =>
                branchesApi(canvas.workspaceId, canvas.path, daemonFetch).merge(src, args)
              }
            />
          )}
          {variationNotice !== null && (
            // role="alert", not "status": every notice here reports a
            // failure (unknown name, unreadable tip, failed switch), and
            // an alert injected with its content is the supported pattern
            // — a conditionally-mounted status region is not
            // (polite-live-region.test.ts).
            <div
              role="alert"
              data-testid="variation-preview-notice"
              className="flex items-center gap-3 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{variationNotice}</span>
              <button
                type="button"
                aria-label="Dismiss"
                className="shrink-0 rounded-md p-1 hover:bg-accent"
                onClick={() => setVariationNotice(null)}
              >
                ×
              </button>
            </div>
          )}
          {capabilities.branches && canvas && (
            <HeaderBranchBanner workspaceId={canvas.workspaceId} path={canvas.path} />
          )}
          {/* This row only exists when it carries something meaningful: a
              capability this keeper does not have. A daemon with full
              capabilities — the common local case — gets no extra header row
              at all (every header row costs canvas height on a phone). The
              shell switcher names the workspace on every page, so it is the
              one carrier of that; raw identifiers are not chrome (ADR-0019). */}
          {(!capabilities.branches || !capabilities.merge) && (
            <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
              {/* WorkspaceTopBar owns the real History/HeaderBranchChip
                  affordances once a canvas is selected; these page-level teasers
                  only surface guidance while the capability itself is unavailable. */}
              {!capabilities.branches && <CapabilityTeaser label="Variations" />}
              {!capabilities.merge && <CapabilityTeaser label="Combine" />}
            </div>
          )}
        </>
      ),
      ...(emptyState === undefined ? {} : { replaceEditor: emptyState }),
      footer: capabilities.merge && canvas && (
        <MergeToast
          workspaceId={canvas.workspaceId}
          path={canvas.path}
          onRestored={clearLocalUndo}
        />
      ),
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
