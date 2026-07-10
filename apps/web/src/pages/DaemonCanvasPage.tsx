import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { useMemo, useState } from 'react'
import { CapabilityTeaser } from '../components/capability-teaser/CapabilityTeaser.js'
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
  // Injectable so tests can avoid real WebSocket networking; production
  // callers rely on the default DaemonBackend + createDaemonFetch wiring.
  createBackend?: (workspaceId: string, slug: string, daemonFetch: typeof fetch) => CanvasBackend
}

function defaultCreateBackend(
  workspaceId: string,
  slug: string,
  daemonFetch: typeof fetch,
): CanvasBackend {
  return new DaemonBackend(workspaceId, slug, window.location.href, { fetch: daemonFetch })
}

export function DaemonCanvasPage({
  daemonBaseUrl,
  workspaceId,
  slug,
  token,
  capabilities = LOCAL_DAEMON_CAPABILITIES,
  createBackend = defaultCreateBackend,
}: DaemonCanvasPageProps) {
  // Stable across the page's lifetime: daemonBaseUrl/token come from a fixed
  // pairing payload, so this never needs to change once mounted.
  const daemonFetch = useMemo(() => createDaemonFetch(daemonBaseUrl, token), [daemonBaseUrl, token])

  const controller = useDaemonCanvasController({ daemonBaseUrl, workspaceId, slug, daemonFetch })

  const [authError, setAuthError] = useState(false)
  const [newCanvasSlug, setNewCanvasSlug] = useState('')

  // Backend identity is keyed on (workspaceId, slug, daemonFetch) — a change
  // to any of these tears down the old connection and opens a new one via
  // useCanvasSync's own effect cleanup (see BrowserLocalCanvasPage for the
  // same ownership split: this hook only decides WHEN to swap identity, not
  // how disconnect/connect ordering happens).
  const backend = useMemo(() => {
    if (controller.workspaceId === null || controller.slug === null) return null
    return createBackend(controller.workspaceId, controller.slug, daemonFetch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createBackend, controller.workspaceId, controller.slug, daemonFetch])

  const { setExcalidrawAPI, onChange } = useCanvasSync(backend, {
    onAuthError: () => setAuthError(true),
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
    <main className="flex h-dvh w-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-2">
        <h1 className="sr-only">Whiteboard (daemon)</h1>
        {authError && (
          <div role="alert" aria-live="assertive" className="text-xs text-destructive">
            The daemon rejected this session. Try re-pairing.
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
          <CapabilityTeaser label="Version history" enabled={capabilities.versions} />
          <CapabilityTeaser label="Workspaces" enabled={capabilities.workspaces} />
          <CapabilityTeaser label="Branches" enabled={capabilities.branches} />
          <CapabilityTeaser label="Merge" enabled={capabilities.merge} />
        </div>
      </header>
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
    </main>
  )
}
