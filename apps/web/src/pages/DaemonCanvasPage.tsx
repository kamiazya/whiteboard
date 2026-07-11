import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { useEffect, useMemo, useState } from 'react'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
import { HeaderBranchChip } from '../components/HeaderBranchChip.js'
import { MergeToast } from '../components/MergeToast.js'
import VersionTimeline from '../components/VersionTimeline.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useCanvasSync } from '../hooks/useCanvasSync.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import { LOCAL_DAEMON_CAPABILITIES, type WhiteboardCapabilities } from '../lib/provider.js'
import { useDaemonCanvasController } from './use-daemon-canvas-controller.js'

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
}

export function DaemonCanvasPage({
  daemonBaseUrl,
  workspaceId,
  slug,
  token,
  capabilities = LOCAL_DAEMON_CAPABILITIES,
  onContinueBrowserLocal,
  createBackend,
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

  const [authError, setAuthError] = useState(false)
  const [newCanvasSlug, setNewCanvasSlug] = useState('')
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)
  // Bumped on an externally observed HEAD change (another client, an MCP
  // tool call) so HeaderBranchChip refetches; the chip's own switch/create/
  // rename/delete actions already refetch internally and don't need this.
  const [branchRefreshSignal, setBranchRefreshSignal] = useState(0)

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
  })

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

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <main className="relative flex h-dvh w-full flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-2">
          <h1 className="sr-only">Whiteboard (daemon)</h1>
          {authError && (
            <div role="alert" aria-live="assertive" className="flex items-center gap-2">
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
          {controller.canvases.length > 0 && controller.slug !== null && (
            <select
              aria-label="Canvases"
              value={controller.slug}
              onChange={(event) => controller.switchCanvas(event.target.value)}
              className="min-w-0 max-w-40 truncate rounded-md border bg-background px-2 py-1 text-xs"
            >
              {controller.canvases.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.slug}
                </option>
              ))}
            </select>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {capabilities.versions ? (
              <button
                type="button"
                aria-pressed={versionPanelOpen}
                onClick={() => setVersionPanelOpen((open) => !open)}
                className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent aria-pressed:bg-accent"
              >
                Version history
              </button>
            ) : (
              // enabled reflects the CAPABILITY, not whether a canvas is
              // selected yet — a fresh empty workspace must not claim the
              // feature needs a daemon connection it already has.
              <CapabilityTeaser label="Version history" enabled={capabilities.versions} />
            )}
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
            {capabilities.branches &&
            controller.workspaceId !== null &&
            controller.slug !== null ? (
              <HeaderBranchChip
                workspaceId={controller.workspaceId}
                slug={controller.slug}
                refreshSignal={branchRefreshSignal}
                mergeEnabled={capabilities.merge}
              />
            ) : (
              <CapabilityTeaser label="Branches" enabled={capabilities.branches} />
            )}
            {/* Merge lives inside HeaderBranchChip's per-branch "Merge into
                HEAD" action (which embeds MergeDialog); there is no separate
                merge entry point. The chip itself disables that action via
                mergeEnabled, so this stays a static teaser only when merge
                is unavailable, matching the other capability indicators. */}
            {!capabilities.merge && <CapabilityTeaser label="Merge" enabled={false} />}
          </div>
        </header>
        {versionPanelOpen && controller.workspaceId !== null && controller.slug !== null && (
          <div className="w-72 shrink-0 border-l bg-background absolute right-0 top-0 bottom-0 z-10 shadow-lg overflow-hidden flex flex-col">
            {/* The panel overlays the header (including the toggle that opened
                it), so it needs its own close affordance rather than relying
                on a control the panel itself may cover. */}
            <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
              <button
                type="button"
                aria-label="Close version history"
                onClick={() => setVersionPanelOpen(false)}
                className="rounded-md border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-accent"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <VersionTimeline
                workspaceId={controller.workspaceId}
                slug={controller.slug}
                onRestored={clearLocalUndo}
              />
            </div>
          </div>
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
        {capabilities.merge && controller.workspaceId !== null && controller.slug !== null && (
          <MergeToast
            workspaceId={controller.workspaceId}
            slug={controller.slug}
            onRestored={clearLocalUndo}
          />
        )}
      </main>
    </DaemonApiContext.Provider>
  )
}
