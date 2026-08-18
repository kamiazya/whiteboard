import { documentsApiUrl, saveVersionResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { DocumentBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { selectDocumentTransport } from '@kamiazya/whiteboard-mcp/select-document-transport'
import { SseBackend } from '@kamiazya/whiteboard-mcp/sse-backend'
import { type DocumentKind, isImageRef } from '@kamiazya/whiteboard-model'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentPresenceChip } from '../components/AgentPresenceChip.js'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import { ConnectionStatus } from '../components/connection/ConnectionStatus.js'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { DocumentEditorSurface } from '../components/document-editor/DocumentEditorSurface.js'
import { NodeTextEditorOverlay } from '../components/document-editor/NodeTextEditorOverlay.js'
import { useNodeInEditor } from '../components/document-editor/use-node-in-editor.js'
import { DocumentProperties } from '../components/document-properties/DocumentProperties.js'
import { ErrorBoundary } from '../components/ErrorBoundary.js'
import { HeaderBranchBanner } from '../components/HeaderBranchBanner.js'
import { HistoryCluster } from '../components/history-cluster/HistoryCluster.js'
import { MergeToast } from '../components/MergeToast.js'
import { createSnapshotAliasResolver } from '../components/markdown-editor/alias-resolver.js'
import type { SpatialEditorHandle } from '../components/spatial-editor/index.js'
import { SpatialEditor } from '../components/spatial-editor/index.js'
import { Button } from '../components/ui/button.js'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useAgentActivity } from '../hooks/use-agent-activity.js'
import { useDocumentFileSeams } from '../hooks/use-document-file-seams.js'
import {
  type MarkdownEmbedLoader,
  useMarkdownEmbedContent,
} from '../hooks/use-markdown-embed-content.js'
import { useDirtyState } from '../hooks/useDirtyState.js'
import { dispatchIdentityEvent, useDocumentSync } from '../hooks/useDocumentSync.js'
import { useFavicon } from '../hooks/useFavicon.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import { createDaemonFileAdapter } from '../lib/daemon-file-adapter.js'
import { deriveNewDocumentPath } from '../lib/derive-new-document-path.js'
import { devTransportOverride } from '../lib/dev-transport-override.js'
import { daemonFaviconStatus, type FaviconStyle, resolveRectColor } from '../lib/favicon.js'
import { readLastTool, resolveInitialTool } from '../lib/initial-tool.js'
import { beginPairingGrant } from '../lib/pairing-grant.js'
import { LOCAL_DAEMON_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { setShellDaemonAuthError } from '../lib/shell-status-store.js'
import { createSharedSseStreamSource } from '../lib/sse-shared-stream-source.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { applyViewportRequest } from '../lib/viewport-request.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
import { useDaemonDocumentController } from './use-daemon-document-controller.js'

const log = getAppLogger('daemon-document-page')

// Lazy so IndexedDB/Loro code (pulled in by ImportBrowserLocalPanel's store
// dependencies) only loads once a canvas is selected and this migration-time
// disclosure is actually mounted, not on every daemon-page load.
const LazyImportSection = lazy(() =>
  import('./daemon-document-import-section.js').then((m) => ({
    default: m.DaemonDocumentImportSection,
  })),
)

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
  // Rendered as a "Continue in browser-local" escape next to the auth-error
  // banner — without it a rejected session leaves the user stuck on a dead
  // daemon page with no way back into the app.
  onContinueBrowserLocal?: () => void
  // Injectable so tests can avoid real WebSocket networking; production
  // callers rely on the default DaemonBackend + createDaemonFetch wiring.
  createBackend?: (workspaceId: string, path: string, daemonFetch: typeof fetch) => DocumentBackend
  // Optional: when provided (the real App.tsx wiring always provides it),
  // renders a collapsed "Import from this browser" disclosure so a user who
  // previously worked browser-local can copy those documents onto this
  // daemon workspace. Absent in tests/embedders that don't need the flow.
  browserLocalStore?: BrowserLocalStore
  // Wired to WorkspaceTopBar's own "Back to canvas list" button. Absent
  // (the default) hides that button — callers that own an index view (the
  // daemon gallery) pass this to return there.
  onNavigateBack?: () => void
}

export function DaemonDocumentPage({
  daemonBaseUrl,
  workspaceId,
  path,
  token,
  capabilities = LOCAL_DAEMON_CAPABILITIES,
  onContinueBrowserLocal,
  createBackend,
  browserLocalStore,
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
  const resolvedCreateBackend = useCallback(
    (workspaceId: string, path: string, daemonFetch: typeof fetch): DocumentBackend => {
      const injected = createBackendRef.current?.(workspaceId, path, daemonFetch)
      if (injected) return injected
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
        return new DaemonBackend(workspaceId, path, daemonBaseUrl, {
          fetch: daemonFetch,
          wsToken: () => token,
        })
      }
      // Null where SharedWorker is unavailable; SseBackend then opens its own
      // stream, which is correct but not shared across tabs.
      const shared = createSharedSseStreamSource(daemonBaseUrl, token) ?? undefined
      return new SseBackend(workspaceId, path, daemonBaseUrl, { fetch: daemonFetch }, shared)
    },
    [daemonBaseUrl, token],
  )

  const controller = useDaemonDocumentController({ daemonBaseUrl, workspaceId, path, daemonFetch })

  // Stable across the page's lifetime, mirroring BrowserLocalDocumentPage's
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
  // Report the live auth error to the App-mounted shell: it means the daemon
  // needs the user's action (re-pair lives under Settings -> Connections),
  // so it counts as disconnected for the attention dot; transient reconnects
  // don't.
  useEffect(() => {
    setShellDaemonAuthError(authError)
    return () => setShellDaemonAuthError(false)
  }, [authError])
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
  const [importSectionOpen, setImportSectionOpen] = useState(false)

  // Backend identity is keyed on (workspaceId, path, daemonFetch) — a change
  // to any of these tears down the old connection and opens a new one via
  // useDocumentSync's own effect cleanup (see BrowserLocalDocumentPage for the
  // same ownership split: this hook only decides WHEN to swap identity, not
  // how disconnect/connect ordering happens).
  const backend = useMemo(() => {
    if (controller.workspaceId === null || controller.path === null) return null
    return resolvedCreateBackend(controller.workspaceId, controller.path, daemonFetch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedCreateBackend, controller.workspaceId, controller.path, daemonFetch])

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
  // updatedAt, exactly as in browser-local mode.
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
  const nodeInEditor = useNodeInEditor(canvasValue, onChange)
  const canvasValueRef = useRef(canvasValue)
  canvasValueRef.current = canvasValue
  const setMarkdownBody = useCallback(
    (next: string) => {
      onChange(canvasValueRef.current, { kind: 'set-body', text: next })
    },
    [onChange],
  )
  const markdownBody = documentKind === 'markdown' && canvasLoaded ? syncedMarkdownBody : null

  // `[[Name]]` aliases resolve against the same list the user can see; the
  // daemon summary carries no display name yet, so the path doubles as one.
  const resolveAlias = useMemo(
    () =>
      createSnapshotAliasResolver(
        controller.documents.map((entry) => ({ id: entry.id ?? entry.path, name: entry.path })),
      ),
    [controller.documents],
  )
  // The same list the alias resolver reads, carried with ids so the picker
  // can fall back to one when a name is ambiguous.
  const linkTargets = useMemo(
    () => controller.documents.map((entry) => ({ id: entry.id ?? entry.path, name: entry.path })),
    [controller.documents],
  )
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
    provider: { kind: 'local-daemon', daemonBaseUrl, capabilities },
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
  useFavicon({
    style: faviconStyle,
    status: daemonFaviconStatus({ authError, syncStatus, isDirty }),
    rects: useMemo(
      () =>
        canvasValue.nodes.map((n) => ({
          x: n.x,
          y: n.y,
          w: n.width,
          h: n.height,
          color: resolveRectColor(n.color),
        })),
      [canvasValue.nodes],
    ),
  })

  // PNG, because the daemon's thumbnail endpoint validates a PNG signature
  // on upload and rejects anything else.
  const getThumbnailBlob = useCallback(() => exportScene('png'), [exportScene])

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
      dispatchIdentityEvent('excalidraw:wb_version_saved', canvas ?? undefined)
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

  // The ONE connection affordance: a header chip whose popover carries
  // the explanation and the available recovery paths — re-pairing always,
  // plus continue-in-browser-local when the host page provides that
  // escape. Re-pairing navigates top-level to the daemon's own /pair
  // consent page, the same trust anchor first-time pairing uses.
  const connectionStatus = (
    <ConnectionStatus
      // Synced is claimed only while the session is actually connected. An
      // auth rejection outranks everything else because re-pairing is the only
      // way out of it; `idle` (not started yet) and `error` are folded in with
      // `reconnecting`, whose copy makes no claim about recovery timing —
      // reporting them as Synced is what this whole change exists to stop.
      state={authError ? 'sync-off' : syncStatus === 'connected' ? 'synced' : 'reconnecting'}
      daemonBaseUrl={daemonBaseUrl}
      onRepair={() => {
        void beginPairingGrant({
          daemonBaseUrl,
          hostedOrigin: window.location.origin,
          sessionStorage: window.sessionStorage,
          navigate: (url) => window.location.assign(url),
        })
      }}
      onContinueBrowserLocal={onContinueBrowserLocal}
      onDisconnect={
        onContinueBrowserLocal &&
        (() => {
          // Recorded so discovery skips it next time: the default port range
          // is rescanned on every visit, so forgetting alone would bring this
          // daemon straight back and make the action look like a no-op.
          settingsStore.update((current) => {
            const known = (current.storage.knownDaemonBaseUrls ?? []).filter(
              (entry) => entry !== daemonBaseUrl,
            )
            const dismissed = (current.storage.dismissedDaemonBaseUrls ?? []).filter(
              (entry) => entry !== daemonBaseUrl,
            )
            // Clearing the stored target is what makes this outlive the page:
            // App.tsx reads localDaemonBaseUrl to decide a load is
            // daemon-backed, so leaving it set reconnects on the next visit
            // and the popover's "this browser stops using it" becomes false.
            const { localDaemonBaseUrl, ...storage } = current.storage
            return {
              ...current,
              storage: {
                ...storage,
                ...(localDaemonBaseUrl === daemonBaseUrl ? {} : { localDaemonBaseUrl }),
                knownDaemonBaseUrls: known,
                dismissedDaemonBaseUrls: [daemonBaseUrl, ...dismissed].slice(0, 5),
              },
            }
          })
          onContinueBrowserLocal()
        })
      }
    />
  )

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      {/* Two-row grid shell: everything header-shaped stacks inside the
          auto row, and the canvas owns minmax(0,1fr) — however many banner
          rows appear (or however tall they wrap), the canvas row is always
          exactly the remaining viewport height, never clipped below it. */}
      <main className="relative grid h-full w-full grid-rows-[auto_minmax(0,1fr)]">
        <div className="min-w-0">
          <h1 className="sr-only">Whiteboard (daemon)</h1>
          {controller.switchError && (
            <div
              role="alert"
              aria-live="assertive"
              className="flex items-center gap-2 border-b bg-background px-4 py-1"
            >
              <span className="text-xs text-destructive">{controller.switchError}</span>
            </div>
          )}
          {/* Rendered at the page level when WorkspaceTopBar has nowhere to
            mount (no-canvas/empty-workspace view) so the degraded state
            never disappears with the canvas-gated chrome. */}
          {authError && !canvas && (
            <div className="flex items-center border-b bg-background px-4 py-1.5">
              {connectionStatus}
            </div>
          )}
          {canvas && (
            <WorkspaceTopBar
              statusSlot={connectionStatus}
              // Document identity in the merged header row, mirroring the
              // browser-local page. The NAME is the workspace's — the top bar
              // hands it down from `/names`, the same surface the canvas
              // dropdown renames through — never a `title` read out of the
              // content, which ADR-0009 decision 2 forbids and
              // `storedCoreFacetsSchema` has no room for.
              titleSlot={(identity) => (
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
                />
              )}
              workspaceId={canvas.workspaceId}
              path={canvas.path}
              documents={controller.documents}
              onNavigateToDocument={controller.switchDocument}
              capabilities={{
                versions: capabilities.versions,
                branches: capabilities.branches,
                merge: capabilities.merge,
              }}
              branchRefreshSignal={branchRefreshSignal}
              onNavigateBack={onNavigateBack}
              onExport={exportScene}
              // Version thumbnails come from the same PNG export path the
              // user can trigger by hand. Without this the save flow skips
              // the upload entirely and latest-thumbnail stays 204 forever.
              getThumbnailBlob={getThumbnailBlob}
              workspaces={
                capabilities.workspaces
                  ? controller.workspaces.map((w) => w.workspaceId)
                  : undefined
              }
              onSwitchWorkspace={(id) => void controller.switchWorkspace(id)}
            />
          )}
          {capabilities.branches && canvas && (
            <HeaderBranchBanner workspaceId={canvas.workspaceId} path={canvas.path} />
          )}
          {/* This row only exists when it carries something meaningful: a
            real workspace CHOICE (two or more), or capability teasers. A
            single-workspace daemon with full capabilities — the common
            local case — gets no extra header row at all (raw ids are not
            chrome, and every header row costs canvas height on a phone). */}
          {(!capabilities.workspaces ||
            (controller.workspaces.length > 1 && !canvas) ||
            !capabilities.versions ||
            !capabilities.branches ||
            !capabilities.merge) && (
            <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
              {capabilities.workspaces ? (
                // WorkspaceTopBar's dropdown is the switcher once a canvas is
                // mounted; this select survives only for the no-canvas state
                // (empty workspace), where that dropdown never mounts and it
                // is the only way to switch back out.
                controller.workspaces.length > 1 &&
                !canvas && (
                  <select
                    aria-label="Workspaces"
                    value={controller.workspaceId ?? ''}
                    onChange={(event) => void controller.switchWorkspace(event.target.value)}
                    className="min-w-0 max-w-40 truncate rounded-md border bg-background px-2 py-1 text-xs"
                  >
                    {controller.workspaces.map((w) => (
                      <option key={w.workspaceId} value={w.workspaceId}>
                        {w.workspaceId}
                      </option>
                    ))}
                  </select>
                )
              ) : (
                <CapabilityTeaser label="Workspaces" enabled={capabilities.workspaces} />
              )}
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
          {canvas && browserLocalStore && (
            <details
              className="border-b bg-background px-4 py-2 text-sm"
              onToggle={(event) => setImportSectionOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Import from this browser
              </summary>
              {/* <details> only hides collapsed children visually — React still
                mounts them. Gate on the open state so the lazy chunk and its
                IndexedDB read are deferred until the user expands the section. */}
              {importSectionOpen && (
                <div className="pt-2">
                  {/* Local boundary: a chunk-load or render failure in this
                    optional disclosure must degrade the section alone, not
                    take the whole editor to the app-level boundary. */}
                  <ErrorBoundary
                    fallback={() => (
                      <p role="alert" className="text-xs text-destructive">
                        Import is unavailable right now. Reopen this section to retry.
                      </p>
                    )}
                  >
                    <Suspense fallback={null}>
                      <LazyImportSection
                        workspaceId={canvas.workspaceId}
                        daemonFetch={daemonFetch}
                        daemonBaseUrl={daemonBaseUrl}
                        browserLocalStore={browserLocalStore}
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )}
            </details>
          )}
        </div>
        {controller.documents.length === 0 ? (
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
                <span aria-hidden="true">← </span>Back to canvas list
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
              <div data-testid="spatial-editor-container" className="relative h-full min-h-0">
                <AgentPresenceChip summary={agentActivity.summary} />
                {/* Keyed on canvas identity: the editor's pan/zoom, in-flight
                gesture and open text editor all describe ONE canvas, and
                `SpatialCanvas` carries no id for the editor to notice a switch
                by. Without the key, switching documents silently inherits the
                previous canvas's viewport. */}
                <SpatialEditor
                  key={canvas ? `${canvas.workspaceId}/${canvas.path}` : 'no-canvas'}
                  // Decided from the canvas's own shape, but only once its
                  // document has loaded — at mount every canvas still looks
                  // empty.
                  initialTool={
                    canvasLoaded
                      ? resolveInitialTool({
                          isEmpty: canvasValue.nodes.length === 0,
                          lastTool: readLastTool(),
                        })
                      : undefined
                  }
                  ref={spatialEditorRef}
                  agentTouchedNodeIds={agentActivity.touchedNodeIds}
                  canvas={canvasValue}
                  onChange={onChange}
                  externalVersion={externalVersion}
                  theme={resolvedTheme}
                  // File-node reference = the target's immutable id (rename-
                  // safe); the label shows its current path and the current
                  // canvas is excluded. Legacy documents still carry path refs,
                  // which resolveRefPath misses and switchDocument takes as-is.
                  // An older daemon's list has no ids yet; those entries fall
                  // back to path refs (same behavior as before ids existed).
                  fileRefOptions={controller.documents
                    .filter((entry) => entry.path !== canvas?.path)
                    .map((entry) => ({
                      file: entry.id ?? entry.path,
                      label: entry.path,
                      kind: entry.kind,
                    }))}
                  onOpenFileRef={(file) => controller.switchDocument(resolveRefPath(file) ?? file)}
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
                      versions={
                        capabilities.versions && canvas
                          ? {
                              workspaceId: canvas.workspaceId,
                              path: canvas.path,
                              onRestored: clearLocalUndo,
                              refreshSignal: versionRefreshSignal,
                              versionPanelExtra,
                            }
                          : undefined
                      }
                    />
                  }
                />
                {nodeInEditor.editing !== null && (
                  <NodeTextEditorOverlay
                    title={canvas?.path ?? 'Untitled'}
                    initialText={nodeInEditor.editing.text}
                    theme={resolvedTheme}
                    resolveAlias={resolveAlias}
                    resolveEmbed={resolveEmbed}
                    linkTargets={linkTargets}
                    onCommit={nodeInEditor.commit}
                    onClose={nodeInEditor.close}
                  />
                )}
              </div>
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
      </main>
    </DaemonApiContext.Provider>
  )
}
