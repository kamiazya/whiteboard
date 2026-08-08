import { saveVersionResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CanvasPageSkeleton } from '../components/CanvasPageSkeleton.js'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import { ConnectionStatus } from '../components/connection/ConnectionStatus.js'
import { ErrorBoundary } from '../components/ErrorBoundary.js'
import { HeaderBranchBanner } from '../components/HeaderBranchBanner.js'
import { MergeToast } from '../components/MergeToast.js'
import { SettingsPanel } from '../components/settings/SettingsPanel.js'
import type { SpatialEditorHandle } from '../components/spatial-editor/index.js'
import { SpatialEditor } from '../components/spatial-editor/index.js'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { dispatchIdentityEvent, useCanvasSync } from '../hooks/useCanvasSync.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import { beginPairingGrant } from '../lib/pairing-grant.js'
import { LOCAL_DAEMON_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
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
  const resolvedCreateBackend = useMemo(
    () =>
      createBackend ??
      ((workspaceId: string, slug: string, daemonFetch: typeof fetch): CanvasBackend =>
        new DaemonBackend(workspaceId, slug, daemonBaseUrl, { fetch: daemonFetch })),
    [createBackend, daemonBaseUrl],
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
  const [newCanvasSlug, setNewCanvasSlug] = useState('')
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
    exportScene,
  } = useCanvasSync(backend, {
    onAuthError: () => setAuthError(true),
    onHeadChanged: () => setBranchRefreshSignal((n) => n + 1),
    onVersionCreated: () => setVersionRefreshSignal((n) => n + 1),
    onViewportRequest: (payload) => applyViewportRequest(payload, spatialEditorRef.current),
    identity: canvas ?? undefined,
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
        className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center"
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
      state={authError ? 'sync-off' : 'synced'}
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
    />
  )

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <main className="relative flex h-dvh w-full flex-col">
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
            versionRefreshSignal={versionRefreshSignal}
            onRestored={clearLocalUndo}
            versionPanelExtra={versionPanelExtra}
            onNavigateBack={onNavigateBack}
            onExport={exportScene}
            onOpenSettings={handleOpenSettings}
          />
        )}
        {capabilities.branches && canvas && (
          <HeaderBranchBanner workspaceId={canvas.workspaceId} slug={canvas.slug} />
        )}
        <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
          {capabilities.workspaces && controller.workspaces.length > 0 ? (
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
        {controller.canvases.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
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
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (!newCanvasSlug.trim()) return
                void controller.createCanvas(newCanvasSlug.trim())
              }}
            >
              <input
                aria-label="New canvas name"
                value={newCanvasSlug}
                onChange={(event) => setNewCanvasSlug(event.target.value)}
                className="rounded-md border bg-background px-2 py-1 text-xs"
              />
              <button
                type="submit"
                className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
              >
                Create canvas
              </button>
            </form>
          </div>
        ) : (
          // Spatial is the only view this slice supports; markdown-view
          // persistence is deferred (canvas-workspace has no markdown-body
          // container to write to yet).
          <div data-testid="spatial-editor-container" className="min-h-0 flex-1">
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
