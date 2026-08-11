import { saveVersionResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { selectCanvasTransport } from '@kamiazya/whiteboard-mcp/select-canvas-transport'
import { SseBackend } from '@kamiazya/whiteboard-mcp/sse-backend'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CanvasPageSkeleton } from '../components/CanvasPageSkeleton.js'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import { ConnectionStatus } from '../components/connection/ConnectionStatus.js'
import { ErrorBoundary } from '../components/ErrorBoundary.js'
import { HeaderBranchBanner } from '../components/HeaderBranchBanner.js'
import { HistoryCluster } from '../components/history-cluster/HistoryCluster.js'
import { MergeToast } from '../components/MergeToast.js'
import { SettingsPanel } from '../components/settings/SettingsPanel.js'
import type { SpatialEditorHandle } from '../components/spatial-editor/index.js'
import { SpatialEditor } from '../components/spatial-editor/index.js'
import { Button } from '../components/ui/button.js'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useCanvasFileSeams } from '../hooks/use-canvas-file-seams.js'
import { dispatchIdentityEvent, useCanvasSync } from '../hooks/useCanvasSync.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import { createDaemonFileAdapter } from '../lib/daemon-file-adapter.js'
import { deriveNewCanvasSlug } from '../lib/derive-new-canvas-slug.js'
import { beginPairingGrant } from '../lib/pairing-grant.js'
import { LOCAL_DAEMON_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { createSharedSseStreamSource } from '../lib/sse-shared-stream-source.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { applyViewportRequest } from '../lib/viewport-request.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
import { useDaemonCanvasController } from './use-daemon-canvas-controller.js'

const log = getAppLogger('daemon-canvas-page')

// Lazy so IndexedDB/Loro code (pulled in by ImportBrowserLocalPanel's store
// dependencies) only loads once a canvas is selected and this migration-time
// disclosure is actually mounted, not on every daemon-page load.
const LazyImportSection = lazy(() =>
  import('./daemon-canvas-import-section.js').then((m) => ({
    default: m.DaemonCanvasImportSection,
  })),
)

export interface DaemonCanvasPageProps {
  daemonBaseUrl: string
  workspaceId?: string
  slug?: string
  // The bootstrap token seeded by useDaemonConnection into
  // window.__WHITEBOARD_DAEMON_TOKEN__. DaemonBackend's WS auth reads that
  // global directly (readDaemonTokenOnce); this prop is only for the HTTP
  // side (createDaemonFetch's Authorization header).
  token?: string
  capabilities?: WhiteboardCapabilities
  // Rendered as a "Continue in browser-local" escape next to the auth-error
  // banner — without it a rejected session leaves the user stuck on a dead
  // daemon page with no way back into the app.
  onContinueBrowserLocal?: () => void
  // Injectable so tests can avoid real WebSocket networking; production
  // callers rely on the default DaemonBackend + createDaemonFetch wiring.
  createBackend?: (workspaceId: string, slug: string, daemonFetch: typeof fetch) => CanvasBackend
  // Optional: when provided (the real App.tsx wiring always provides it),
  // renders a collapsed "Import from this browser" disclosure so a user who
  // previously worked browser-local can copy those canvases onto this
  // daemon workspace. Absent in tests/embedders that don't need the flow.
  browserLocalStore?: BrowserLocalStore
  // Wired to WorkspaceTopBar's own "Back to canvas list" button. Absent
  // (the default) hides that button — callers that own an index view (the
  // daemon gallery) pass this to return there.
  onNavigateBack?: () => void
}

export function DaemonCanvasPage({
  daemonBaseUrl,
  workspaceId,
  slug,
  token,
  capabilities = LOCAL_DAEMON_CAPABILITIES,
  onContinueBrowserLocal,
  createBackend,
  browserLocalStore,
  onNavigateBack,
}: DaemonCanvasPageProps) {
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
    (workspaceId: string, slug: string, daemonFetch: typeof fetch): CanvasBackend => {
      const injected = createBackendRef.current?.(workspaceId, slug, daemonFetch)
      if (injected) return injected
      // A secure page cannot open a ws:// socket to an http daemon at all, so
      // the transport is decided up front rather than attempted and retried.
      const transport = selectCanvasTransport({
        pageOrigin: window.location.origin,
        daemonBaseUrl,
      })
      if (transport !== 'sse') {
        return new DaemonBackend(workspaceId, slug, daemonBaseUrl, { fetch: daemonFetch })
      }
      // Null where SharedWorker is unavailable; SseBackend then opens its own
      // stream, which is correct but not shared across tabs.
      const shared = createSharedSseStreamSource(daemonBaseUrl, token) ?? undefined
      return new SseBackend(workspaceId, slug, daemonBaseUrl, { fetch: daemonFetch }, shared)
    },
    [daemonBaseUrl, token],
  )

  const controller = useDaemonCanvasController({ daemonBaseUrl, workspaceId, slug, daemonFetch })

  // Stable across the page's lifetime, mirroring BrowserLocalCanvasPage's
  // own settingsStore — read fresh (not cached in state) wherever the
  // current capabilities.webMcpEnabled value is needed.
  const [settingsStore] = useState(() => createUserSettingsStore())

  const { theme, resolvedTheme, setTheme } = useThemeMode()

  // The selected (workspaceId, slug) pair once both are known, computed once so
  // every downstream guard and child prop shares a single non-null narrowing
  // instead of repeating `workspaceId !== null && slug !== null`.
  const canvas =
    controller.workspaceId !== null && controller.slug !== null
      ? { workspaceId: controller.workspaceId, slug: controller.slug }
      : null

  const [authError, setAuthError] = useState(false)
  // Disables the empty-state "Create a canvas" control while a create is in
  // flight. `disabled` is the whole mechanism, deliberately with no
  // `if (creating) return` guard inside the handler — see
  // DaemonIndexPage.tsx's own `creating` state for why that guard was tried
  // and removed there (stale closure read in the same-tick double-press
  // case it exists to catch).
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

  // Backend identity is keyed on (workspaceId, slug, daemonFetch) — a change
  // to any of these tears down the old connection and opens a new one via
  // useCanvasSync's own effect cleanup (see BrowserLocalCanvasPage for the
  // same ownership split: this hook only decides WHEN to swap identity, not
  // how disconnect/connect ordering happens).
  const backend = useMemo(() => {
    if (controller.workspaceId === null || controller.slug === null) return null
    return resolvedCreateBackend(controller.workspaceId, controller.slug, daemonFetch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedCreateBackend, controller.workspaceId, controller.slug, daemonFetch])

  // A rejected session belongs to one backend identity — switching to a new
  // canvas opens a fresh connection, so a stale banner must not outlive the
  // backend that produced it. Only resets on a genuine new (non-null)
  // connection: dropping to no backend at all (e.g. switching into a
  // workspace with zero canvases) leaves authError as-is, because live sync
  // is still off either way and the persistent indicator should stay lit.
  useEffect(() => {
    if (backend) setAuthError(false)
  }, [backend])

  // Holds the mounted SpatialEditor's imperative handle so a daemon-driven
  // viewport_request (see onViewportRequest below) can reach it without
  // useCanvasSync/canvas-sync-session owning a DOM-facing ref themselves.
  const spatialEditorRef = useRef<SpatialEditorHandle | null>(null)

  const {
    canvas: canvasValue,
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
    lockedEdgeIds,
    setEdgeLock,
    syncStatus,
  } = useCanvasSync(backend, {
    onAuthError: () => setAuthError(true),
    onHeadChanged: () => setBranchRefreshSignal((n) => n + 1),
    onVersionCreated: () => setVersionRefreshSignal((n) => n + 1),
    onViewportRequest: (payload) => applyViewportRequest(payload, spatialEditorRef.current),
    identity: canvas ?? undefined,
  })

  // Canvas embeds (J5a) and image nodes (J5b), over the daemon's own file and
  // snapshot routes. The staleness stamp is the referenced canvas's
  // updatedAt, exactly as in browser-local mode.
  const fileSeams = useCanvasFileSeams({
    canvas: canvasValue,
    adapter: useMemo(
      () =>
        createDaemonFileAdapter({
          daemonFetch,
          daemonBaseUrl,
          workspaceId: canvas?.workspaceId ?? '',
          slug: canvas?.slug ?? '',
        }),
      [daemonFetch, daemonBaseUrl, canvas?.workspaceId, canvas?.slug],
    ),
    stampOf: useMemo(
      () => new Map(controller.canvases.map((entry) => [entry.slug, entry.updatedAt ?? ''])),
      [controller.canvases],
    ),
  })

  const commands = useWhiteboardCommands({
    provider: { kind: 'local-daemon', daemonBaseUrl, capabilities },
    // The daemon canvas summary carries no display name yet (only
    // slug/updatedAt) — the slug doubles as `name` until that changes.
    canvas:
      canvas !== null
        ? { workspaceId: canvas.workspaceId, canvasId: canvas.slug, name: canvas.slug }
        : null,
  })

  // Identity key = workspaceId+slug, matching this page's own canvas
  // Reactive: toggling in the SettingsPanel updates this state, which causes
  // useBrowserToolRegistry to re-run (ON→OFF triggers abort via the hook's
  // internal AbortController; OFF→ON re-registers without a page reload).
  const [webMcpEnabled, setWebMcpEnabled] = useState(
    () => settingsStore.load().capabilities.webMcpEnabled !== false,
  )
  useBrowserToolRegistry(
    commands,
    canvas !== null ? `${canvas.workspaceId}/${canvas.slug}` : null,
    webMcpEnabled,
  )

  const [settingsOpen, setSettingsOpen] = useState(false)
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), [])

  // PNG, because the daemon's thumbnail endpoint validates a PNG signature
  // on upload and rejects anything else.
  const getThumbnailBlob = useCallback(() => exportScene('png'), [exportScene])

  // Creation is immediate — no name is collected up front (ADR-0006 point
  // 3). A slug is derived from the loaded canvases so it never collides with
  // one already in this workspace; naming happens afterwards, in the opened
  // canvas's own top bar. Mirrors DaemonIndexPage.tsx's empty-state handler.
  const handleCreateCanvas = async (): Promise<void> => {
    setCreating(true)
    try {
      await controller.createCanvas(deriveNewCanvasSlug(controller.canvases.map((c) => c.slug)))
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
        `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(canvas.workspaceId)}/canvases/${encodeURIComponent(canvas.slug)}/versions`,
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
      // identity-scoped event useCanvasSync fires on a broadcast — otherwise
      // HeaderSaveDot never learns this save happened and stays dirty.
      dispatchIdentityEvent('excalidraw:version_saved', canvas ?? undefined)
    } catch {
      setSaveVersionMessage({ kind: 'error', text: 'Save failed. Please try again.' })
    } finally {
      setSavingVersion(false)
    }
  }

  if (controller.loading) {
    return <CanvasPageSkeleton label="Connecting to daemon" />
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
              workspaceId={canvas.workspaceId}
              slug={canvas.slug}
              canvases={controller.canvases}
              onNavigateToCanvas={controller.switchCanvas}
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
              onOpenSettings={handleOpenSettings}
            />
          )}
          {capabilities.branches && canvas && (
            <HeaderBranchBanner workspaceId={canvas.workspaceId} slug={canvas.slug} />
          )}
          {/* This row only exists when it carries something meaningful: a
            real workspace CHOICE (two or more), or capability teasers. A
            single-workspace daemon with full capabilities — the common
            local case — gets no extra header row at all (raw ids are not
            chrome, and every header row costs canvas height on a phone). */}
          {(!capabilities.workspaces ||
            controller.workspaces.length > 1 ||
            !capabilities.versions ||
            !capabilities.branches ||
            !capabilities.merge) && (
            <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
              {capabilities.workspaces ? (
                controller.workspaces.length > 1 && (
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
        {controller.canvases.length === 0 ? (
          <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
            {/* WorkspaceTopBar (the usual home for this button) only mounts once
                a canvas is selected, so a workspace that resolves to zero
                canvases — an empty workspace, or a gallery row whose canvas was
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
            <p className="text-sm text-muted-foreground">This workspace has no canvases yet.</p>
            {controller.createError && (
              <div role="alert" aria-live="assertive" className="text-xs text-destructive">
                {controller.createError}
              </div>
            )}
            {/* An empty state is a reading surface, not a dense toolbar strip
                (ADR-0006 point 4) — the control keeps its text label rather
                than becoming an icon-only "+", matching DaemonIndexPage's
                own empty-state "Create a canvas" button. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={creating}
              onClick={() => void handleCreateCanvas()}
            >
              Create a canvas
            </Button>
          </div>
        ) : (
          // Spatial is the only view this slice supports; markdown-view
          // persistence is deferred (canvas-workspace has no markdown-body
          // container to write to yet).
          <div data-testid="spatial-editor-container" className="relative h-full min-h-0">
            {/* Keyed on canvas identity: the editor's pan/zoom, in-flight
                gesture and open text editor all describe ONE canvas, and
                `SpatialCanvas` carries no id for the editor to notice a switch
                by. Without the key, switching canvases silently inherits the
                previous canvas's viewport. */}
            <SpatialEditor
              key={canvas ? `${canvas.workspaceId}/${canvas.slug}` : 'no-canvas'}
              ref={spatialEditorRef}
              canvas={canvasValue}
              onChange={onChange}
              externalVersion={externalVersion}
              theme={resolvedTheme}
              // File-node reference = the canvas slug within this workspace
              // (the daemon's alias path); the current canvas is excluded.
              fileRefOptions={controller.canvases
                .filter((entry) => entry.slug !== canvas?.slug)
                .map((entry) => ({ file: entry.slug, label: entry.slug }))}
              onOpenFileRef={(file) => controller.switchCanvas(file)}
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
                  versions={
                    capabilities.versions && canvas
                      ? {
                          workspaceId: canvas.workspaceId,
                          slug: canvas.slug,
                          onRestored: clearLocalUndo,
                          refreshSignal: versionRefreshSignal,
                          versionPanelExtra,
                        }
                      : undefined
                  }
                />
              }
            />
          </div>
        )}
        {capabilities.merge && canvas && (
          <MergeToast
            workspaceId={canvas.workspaceId}
            slug={canvas.slug}
            onRestored={clearLocalUndo}
          />
        )}
        <SettingsPanel
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          theme={theme}
          onThemeChange={setTheme}
          webMcpEnabled={webMcpEnabled}
          onWebMcpChange={setWebMcpEnabled}
        />
      </main>
    </DaemonApiContext.Provider>
  )
}
