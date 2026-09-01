import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import { documentsApiUrl, saveVersionResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { DocumentBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { selectDocumentTransport } from '@kamiazya/whiteboard-mcp/select-document-transport'
import { SseBackend } from '@kamiazya/whiteboard-mcp/sse-backend'
import { type DocumentKind, isImageRef } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentPresenceChip } from '../components/AgentPresenceChip.js'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import type { ConnectionsBacklink } from '../components/connections/ConnectionsChip.js'
import { ConnectionsChip } from '../components/connections/ConnectionsChip.js'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { DocumentEditorSurface } from '../components/document-editor/DocumentEditorSurface.js'
import { DocumentPageShell } from '../components/document-editor/DocumentPageShell.js'
import { SpatialEditorPane } from '../components/document-editor/SpatialEditorPane.js'
import { useNodeInEditor } from '../components/document-editor/use-node-in-editor.js'
import { DocumentProperties } from '../components/document-properties/DocumentProperties.js'
import { HeaderBranchBanner } from '../components/HeaderBranchBanner.js'
import { MergeToast } from '../components/MergeToast.js'
import { CanvasDisplaySettings } from '../components/spatial-editor/CanvasDisplaySettings.js'
import type { SpatialEditorHandle } from '../components/spatial-editor/index.js'
import { Button } from '../components/ui/button.js'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import { DocumentMenu } from '../components/workspace-top-bar/DocumentMenu.js'
import { sanitizeExportFilenameBase } from '../components/workspace-top-bar/export-filename.js'
import { useSceneExport } from '../components/workspace-top-bar/useSceneExport.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useAgentActivity } from '../hooks/use-agent-activity.js'
import { useDocumentFileSeams } from '../hooks/use-document-file-seams.js'
import {
  type MarkdownEmbedLoader,
  useMarkdownEmbedContent,
} from '../hooks/use-markdown-embed-content.js'
import { useDirtyState } from '../hooks/useDirtyState.js'
import { useDocumentOutline } from '../hooks/useDocumentOutline.js'
import { dispatchIdentityEvent, useDocumentSync } from '../hooks/useDocumentSync.js'
import { useFavicon } from '../hooks/useFavicon.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import {
  createDaemonFetch,
  getDocumentBacklinks,
  linkifyDocumentMentions,
} from '../lib/daemon-api-client.js'
import { createDaemonFileAdapter } from '../lib/daemon-file-adapter.js'
import { daemonLinkEntries, daemonLinkTargets } from '../lib/daemon-link-entries.js'
import { deriveNewDocumentPath } from '../lib/derive-new-document-path.js'
import { devTransportOverride } from '../lib/dev-transport-override.js'
import { daemonFaviconStatus, type FaviconStyle } from '../lib/favicon.js'
import { DAEMON_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { scheduleReplicaRefresh } from '../lib/replica-refresh.js'
import { setShellConnection } from '../lib/shell-status-store.js'
import { createSharedSseStreamSource } from '../lib/sse-shared-stream-source.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { applyViewportRequest } from '../lib/viewport-request.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
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

export function DaemonDocumentPage({
  daemonBaseUrl,
  workspaceId,
  path,
  token,
  capabilities = DAEMON_CAPABILITIES,
  createBackend,
  onNavigateBack,
}: DaemonDocumentPageProps) {
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

  // ADR-0023 decision 5's arrival path: the moment this browser is working
  // on a daemon workspace is when it can afford to refresh its replica of
  // it. Once per session per workspace, scheduled off the critical path —
  // the module dedupes, so the effect can fire on every resolve.
  useEffect(() => {
    if (controller.workspaceId === null) return
    scheduleReplicaRefresh({
      fetch: daemonFetch,
      daemonBaseUrl,
      workspaceId: controller.workspaceId,
    })
  }, [daemonFetch, daemonBaseUrl, controller.workspaceId])

  // Stable across the page's lifetime, mirroring BrowserDocumentPage's
  // own settingsStore — read fresh (not cached in state) wherever the
  // current capabilities.webMcpEnabled value is needed.
  const [settingsStore] = useState(() => createUserSettingsStore())

  const { resolvedTheme } = useThemeMode()

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
  // Bumped on any version_created broadcast (covers this button's own save,
  // MCP tool saves, and other peers) so an open VersionTimeline updates
  // without waiting for its 15s poll.
  const [versionRefreshSignal, setVersionRefreshSignal] = useState(0)
  const [savingVersion, setSavingVersion] = useState(false)
  const [saveVersionMessage, setSaveVersionMessage] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)

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

  const {
    canvas: canvasValue,
    loaded: canvasLoaded,
    onChange,
    externalVersion,
    clearLocalUndo,
    undo,
    redo,
    canUndo,
    canRedo,
    exportScene,
    lockedNodeIds,
    setNodeLock,
    markdownBody: syncedMarkdownBody,
    coreFacets,
    setCoreFacets,
    lockedEdgeIds,
    setEdgeLock,
    syncStatus,
  } = useDocumentSync(backend, {
    ...(backendState?.contentDocumentId === undefined
      ? {}
      : { contentDocumentId: backendState.contentDocumentId }),
    onAuthError: () => setAuthError(true),
    onHeadChanged: () => setBranchRefreshSignal((n) => n + 1),
    onVersionCreated: () => setVersionRefreshSignal((n) => n + 1),
    onViewportRequest: (payload) => applyViewportRequest(payload, spatialEditorRef.current),
    onAgentActivity: (payload) => reportAgentActivity(payload),
    identity: canvas ?? undefined,
  })

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

  // Canvas embeds (J5a) and image nodes (J5b), over the daemon's own file and
  // snapshot routes. The staleness stamp is the referenced canvas's
  // updatedAt, exactly as in browser mode.
  const fileSeams = useDocumentFileSeams({
    canvas: canvasValue,
    adapter: fileAdapter,
    // Keyed by BOTH id and path so id refs and legacy path refs each find
    // their staleness stamp.
    stampOf: useMemo(
      () =>
        new Map(
          controller.documents.flatMap((entry) => [
            [entry.path, entry.updatedAt ?? ''] as const,
            ...(entry.id ? [[entry.id, entry.updatedAt ?? ''] as const] : []),
          ]),
        ),
      [controller.documents],
    ),
  })

  // The open document's kind, from the documents list summary (default
  // 'spatial'). It picks which editor DocumentEditorSurface mounts — the
  // page itself no longer chooses an editor.
  const documentKind: DocumentKind =
    controller.documents.find((entry) => entry.path === controller.path)?.kind ?? 'spatial'

  // A markdown document's body lives in the doc's `body` text container —
  // the one place it is stored, and the shape `wb_document_set` writes. The
  // read comes from the sync session (which republishes it on hydration,
  // remote import and undo alike) and the write travels the session's
  // ordinary command path, so a body edit gets the same debounce, undo step
  // and local-update forwarding as every other change, with no second write
  // pipeline. `set-body` carries the WHOLE body, so it needs no canvas: the
  // value passed alongside is the unchanged one this command does not touch.
  // The CONTROLLER's identity, not this page's props. They are not the same
  // thing: the controller owns its own `path` and `switchDocument`, and five
  // call sites here move the document without the props ever changing — one
  // of them is this very surface's own link-following
  // (`onOpenDocument` below). Keying on the props would leave the surface
  // open across exactly the switch it is most likely to be part of.
  const nodeInEditor = useNodeInEditor(
    canvasValue,
    onChange,
    `${controller.workspaceId}:${controller.path}`,
  )
  const canvasValueRef = useRef(canvasValue)
  canvasValueRef.current = canvasValue
  const setMarkdownBody = useCallback(
    (next: string) => {
      onChange(canvasValueRef.current, { kind: 'set-body', text: next })
    },
    [onChange],
  )
  const markdownBody = documentKind === 'markdown' && canvasLoaded ? syncedMarkdownBody : null

  // `[[Name]]` aliases resolve against the same list the user can see — by
  // display name AND by path, since only the path is addressable and only
  // the name is the user's own word for the document.
  const resolveAlias = useMemo(
    () => createUniqueNameResolver(daemonLinkEntries(controller.documents)),
    [controller.documents],
  )
  // The same list, one row per document, carried with ids so the picker can
  // fall back to one when a name is ambiguous.
  const linkTargets = useMemo(
    () =>
      daemonLinkTargets(controller.documents, {
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
  const loadEmbedSource = useCallback<MarkdownEmbedLoader>(
    async (documentId) => {
      const target = await fileAdapter.loadDocument(documentId)
      if (target?.body === undefined) return undefined
      // Body only. A document's title is the workspace's (ADR-0009 decision
      // 2) and the daemon summary carries no display name, so there is none
      // to label the embed with — the facets deliberately no longer hold one.
      return { body: target.body }
    },
    [fileAdapter],
  )
  const resolveEmbed = useMarkdownEmbedContent({
    body: markdownBody ?? '',
    resolveAlias,
    load: loadEmbedSource,
  })

  const commands = useWhiteboardCommands({
    provider: { kind: 'daemon', daemonBaseUrl, capabilities },
    // The daemon canvas summary carries no display name yet (only
    // path/updatedAt) — the path doubles as `name` until that changes.
    canvas:
      canvas !== null
        ? { workspaceId: canvas.workspaceId, documentId: canvas.path, name: canvas.path }
        : null,
  })

  // Identity key = workspaceId+path, matching this page's own canvas.
  // Read once at mount: the routed /settings page is the only place this
  // toggles, and navigating there and back remounts this page (a route
  // change), which re-reads the store fresh — no in-mount reactivity needed.
  const webMcpEnabled = settingsStore.load().capabilities.webMcpEnabled !== false
  useBrowserToolRegistry(
    commands,
    canvas !== null ? `${canvas.workspaceId}/${canvas.path}` : null,
    webMcpEnabled,
  )

  // Tab favicon: sync state as the status dot, scene content as the minimap
  // (style user-selectable on the routed /settings page; same remount-
  // re-reads reasoning as webMcpEnabled above).
  const faviconStyle: FaviconStyle = settingsStore.load().appearance?.faviconStyle ?? 'minimap'
  const { isDirty } = useDirtyState(canvas?.workspaceId ?? '', canvas?.path ?? '')
  // One shape for whichever kind this document is — the favicon draws
  // it today, and a tree row's icon draws the same one.
  const documentOutline = useDocumentOutline({
    kind: documentKind,
    canvas: canvasValue,
    markdownBody,
  })

  useFavicon({
    style: faviconStyle,
    status: daemonFaviconStatus({ authError, syncStatus, isDirty }),
    rects: documentOutline,
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

  // PNG, because the daemon's thumbnail endpoint validates a PNG signature
  // on upload and rejects anything else.
  const getThumbnailBlob = useCallback(() => exportScene('png'), [exportScene])

  // The document's own verbs live on the document's ⋯, the same as on the
  // browser page — one object, one action menu (ADR-0006).
  const { exportError, handleExport } = useSceneExport({
    onExport: exportScene,
    filenameBase: sanitizeExportFilenameBase(canvas?.path ?? 'canvas'),
    log,
  })

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

  const saveVersion = async (): Promise<void> => {
    if (!capabilities.versions || canvas === null || savingVersion) return
    setSavingVersion(true)
    setSaveVersionMessage(null)
    try {
      const res = await daemonFetch(
        `${daemonBaseUrl}${documentsApiUrl(canvas.workspaceId, canvas.path, 'versions')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      if (!res.ok) throw new Error(`save failed: ${res.status}`)
      const parsed = saveVersionResponseSchema.safeParse(await res.json().catch(() => null))
      if (!parsed.success) {
        log.error('POST /versions response did not match saveVersionResponseSchema:', parsed.error)
        throw new Error('save response did not match schema')
      }
      setSaveVersionMessage({ kind: 'success', text: 'Version saved.' })
      setVersionRefreshSignal((n) => n + 1)
      // The server's manual POST /versions route does not broadcast
      // version_created over the websocket (that only fires for auto-saves
      // and other peers' saves), so this button must dispatch the same
      // identity-scoped event useDocumentSync fires on a broadcast — otherwise
      // HeaderSaveDot never learns this save happened and stays dirty.
      dispatchIdentityEvent('whiteboard:wb_version_saved', canvas ?? undefined)
    } catch {
      setSaveVersionMessage({ kind: 'error', text: 'Save failed. Please try again.' })
    } finally {
      setSavingVersion(false)
    }
  }

  if (controller.loading) {
    return <DocumentPageSkeleton label="Connecting to daemon" />
  }

  if (controller.loadError) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <p className="max-w-md text-sm text-destructive">{controller.loadError}</p>
      </div>
    )
  }

  const versionPanelExtra =
    capabilities.versions && canvas ? (
      <div className="flex flex-wrap items-center gap-2 border-t px-2 py-2">
        <button
          type="button"
          onClick={() => void saveVersion()}
          disabled={savingVersion}
          className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {savingVersion ? 'Saving…' : 'Save version'}
        </button>
        {saveVersionMessage && (
          <span
            role={saveVersionMessage.kind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            className={
              saveVersionMessage.kind === 'error'
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {saveVersionMessage.text}
          </span>
        )}
      </div>
    ) : null

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <DocumentPageShell
        srTitle="Whiteboard (daemon)"
        header={
          <>
            {canvas && (
              <WorkspaceTopBar
                // Document identity in the merged header row, mirroring the
                // browser page. The NAME is the workspace's — the top bar
                // hands it down from `/names`, the same surface the canvas
                // dropdown renames through — never a `title` read out of the
                // content, which ADR-0009 decision 2 forbids and
                // `storedCoreFacetsSchema` has no room for.
                titleSlot={(identity) => (
                  <>
                    <DocumentProperties
                      inline
                      key={`${canvas.workspaceId}/${canvas.path}`}
                      title={identity.name}
                      onTitleChange={identity.onRename}
                      // Facets are OKF frontmatter, so only a markdown document
                      // has any — `readCoreFacets` answers `undefined` for a
                      // spatial one (ADR-0009 decision 3), which is what decides
                      // the disclosure here without a second flag to keep in sync.
                      facets={coreFacets}
                      onFacetsChange={setCoreFacets}
                      // Canvas-level display settings, gated on kind the same
                      // way the facet disclosure above is: a markdown document
                      // has no canvas to configure. The browser page has placed
                      // this since it existed and this one did not, which left
                      // every `canvasSettings` contribution — today `visual`'s
                      // `visual.edges/v0` — unreachable in daemon mode.
                      settings={
                        documentKind === 'spatial' ? (
                          <CanvasDisplaySettings canvas={canvasValue} onChange={onChange} />
                        ) : undefined
                      }
                      actions={
                        <>
                          {exportError && (
                            <span className="text-destructive truncate text-xs" role="alert">
                              {exportError}
                            </span>
                          )}
                          <DocumentMenu onExport={(format) => void handleExport(format)} />
                        </>
                      }
                    />
                    <ConnectionsChip
                      backlinks={connections === null ? null : connections.backlinks}
                      mentions={connections?.unlinkedMentions}
                      onOpen={(entry) => controller.switchDocument(entry.path)}
                      onLinkify={(mention) => {
                        if (controller.workspaceId === null || currentDocumentId === undefined)
                          return
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
                  </>
                )}
                workspaceId={canvas.workspaceId}
                path={canvas.path}
                capabilities={{
                  versions: capabilities.versions,
                  branches: capabilities.branches,
                  merge: capabilities.merge,
                }}
                branchRefreshSignal={branchRefreshSignal}
                onNavigateBack={onNavigateBack}
                // Version thumbnails come from the same PNG export path the
                // user can trigger by hand. Without this the save flow skips
                // the upload entirely and latest-thumbnail stays 204 forever.
                getThumbnailBlob={getThumbnailBlob}
              />
            )}
            {capabilities.branches && canvas && (
              <HeaderBranchBanner workspaceId={canvas.workspaceId} path={canvas.path} />
            )}
            {/* This row only exists when it carries something meaningful: a
            capability this keeper does not have. A daemon with full
            capabilities — the common local case — gets no extra header row
            at all (every header row costs canvas height on a phone).

            It used to also carry a workspace select, which showed raw
            canonical ids as its own option labels — the "Raw identifiers are
            not chrome" defect ADR-0019 exists to fix — behind a comment that
            had gone stale: it deferred to a WorkspaceTopBar dropdown that no
            longer exists. The shell switcher names the workspace on every
            page, this one included, so it is the one carrier now. */}
            {(!capabilities.versions || !capabilities.branches || !capabilities.merge) && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
                {/* WorkspaceTopBar owns the real History/HeaderSaveDot/HeaderBranchChip
              affordances once a canvas is selected; these page-level teasers only
              surface guidance while the capability itself is unavailable. */}
                {!capabilities.versions && (
                  <CapabilityTeaser label="Version history" enabled={capabilities.versions} />
                )}
                {!capabilities.branches && (
                  <CapabilityTeaser label="Variations" enabled={capabilities.branches} />
                )}
                {!capabilities.merge && <CapabilityTeaser label="Combine" enabled={false} />}
              </div>
            )}
          </>
        }
      >
        {canvas !== null &&
        controller.documents.length > 0 &&
        workspaceSyncDocumentId === undefined ? (
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
              Nothing is at <span className="font-medium text-foreground">“{canvas.path}”</span> in
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
                void controller.createDocument(canvas.path).finally(() => setCreating(false))
              }}
            >
              Create a canvas at this path
            </Button>
          </div>
        ) : controller.documents.length === 0 ? (
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
        ) : (
          <DocumentEditorSurface
            kind={documentKind}
            documentKey={canvas ? `${canvas.workspaceId}/${canvas.path}` : 'no-canvas'}
            markdown={{
              body: markdownBody,
              setBody: setMarkdownBody,
              theme: resolvedTheme,
              meta: coreFacets ?? { type: documentKind },
              resolveAlias,
              linkTargets,
              onOpenDocument: (id) => controller.switchDocument(resolveRefPath(id) ?? id),
              resolveEmbed,
            }}
            spatial={() => (
              <SpatialEditorPane
                className="relative h-full min-h-0"
                editorKey={canvas ? `${canvas.workspaceId}/${canvas.path}` : 'no-canvas'}
                canvasLoaded={canvasLoaded}
                editorRef={spatialEditorRef}
                agentTouchedNodeIds={agentActivity.touchedNodeIds}
                canvas={canvasValue}
                onChange={onChange}
                externalVersion={externalVersion}
                theme={resolvedTheme}
                // File-node reference = the target's immutable id (rename-
                // safe); the label shows its current path and the current
                // canvas is excluded. Legacy documents still carry path refs,
                // which resolveRefPath misses and switchDocument takes as-is.
                fileRefOptions={controller.documents
                  .filter((entry) => entry.path !== canvas?.path)
                  .map((entry) => ({
                    file: entry.id,
                    label: entry.path,
                    kind: entry.kind,
                  }))}
                onOpenDocument={(id) => controller.switchDocument(resolveRefPath(id) ?? id)}
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
                  versions:
                    capabilities.versions && canvas
                      ? {
                          workspaceId: canvas.workspaceId,
                          path: canvas.path,
                          onRestored: clearLocalUndo,
                          refreshSignal: versionRefreshSignal,
                          versionPanelExtra,
                        }
                      : undefined,
                }}
                overlayTitle={canvas?.path ?? 'Untitled'}
                resolveAlias={resolveAlias}
                resolveEmbed={resolveEmbed}
                linkTargets={linkTargets}
              >
                <AgentPresenceChip summary={agentActivity.summary} />
              </SpatialEditorPane>
            )}
          />
        )}
        {capabilities.merge && canvas && (
          <MergeToast
            workspaceId={canvas.workspaceId}
            path={canvas.path}
            onRestored={clearLocalUndo}
          />
        )}
      </DocumentPageShell>
    </DaemonApiContext.Provider>
  )
}
