import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { saveVersionResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import { HeaderBranchBanner } from '../components/HeaderBranchBanner.js'
import { MergeToast } from '../components/MergeToast.js'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { dispatchIdentityEvent, useCanvasSync } from '../hooks/useCanvasSync.js'
import { getAppLogger } from '../lib/app-logger.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import { LOCAL_DAEMON_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
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
  // backend that produced it.
  useEffect(() => {
    setAuthError(false)
  }, [backend])

  const { setExcalidrawAPI, onChange, clearLocalUndo } = useCanvasSync(backend, {
    onAuthError: () => setAuthError(true),
    onHeadChanged: () => setBranchRefreshSignal((n) => n + 1),
    onVersionCreated: () => setVersionRefreshSignal((n) => n + 1),
    identity: canvas ?? undefined,
  })

  const saveVersion = async (): Promise<void> => {
    if (!capabilities.versions || canvas === null || savingVersion) return
    setSavingVersion(true)
    setSaveVersionMessage(null)
    try {
      const res = await daemonFetch(
        `${daemonBaseUrl}/api/workspaces/${canvas.workspaceId}/canvases/${encodeURIComponent(canvas.slug)}/versions`,
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
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-dvh items-center justify-center text-sm text-muted-foreground"
      >
        Connecting to daemon…
      </div>
    )
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
        {authError && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-center gap-2 border-b bg-background px-4 py-1"
          >
            <span className="text-xs text-destructive">
              The daemon rejected this session. Try re-pairing.
            </span>
            {onContinueBrowserLocal && (
              <button
                type="button"
                onClick={onContinueBrowserLocal}
                className="rounded-md border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-accent"
              >
                Continue in browser-local
              </button>
            )}
          </div>
        )}
        {canvas && (
          <WorkspaceTopBar
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
            <CapabilityTeaser label="Branches" enabled={capabilities.branches} />
          )}
          {!capabilities.merge && <CapabilityTeaser label="Merge" enabled={false} />}
        </div>
        {canvas && browserLocalStore && (
          <details className="border-b bg-background px-4 py-2 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Import from this browser
            </summary>
            <div className="pt-2">
              <Suspense fallback={null}>
                <LazyImportSection
                  workspaceId={canvas.workspaceId}
                  daemonFetch={daemonFetch}
                  daemonBaseUrl={daemonBaseUrl}
                  browserLocalStore={browserLocalStore}
                />
              </Suspense>
            </div>
          </details>
        )}
        {controller.canvases.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
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
          <div className="min-h-0 flex-1">
            <Excalidraw excalidrawAPI={setExcalidrawAPI} onChange={onChange} />
          </div>
        )}
        {capabilities.merge && canvas && (
          <MergeToast
            workspaceId={canvas.workspaceId}
            slug={canvas.slug}
            onRestored={clearLocalUndo}
          />
        )}
      </main>
    </DaemonApiContext.Provider>
  )
}
