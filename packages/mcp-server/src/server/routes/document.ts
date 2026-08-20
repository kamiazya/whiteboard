import { Hono } from 'hono'
import { installAutoCompact } from '../store/auto-compact.js'
import { FileVersionStore, type VersionStore } from '../store/version-store.js'
import { setBroadcastFn } from './document/_shared.js'
import { AUTO_VERSION_INTERVAL_MS, createAutoVersionTrigger } from './document/auto-version.js'
import { createDocumentSvgExportRouter } from './document/export-svg.js'
import { createLiveDocRouter } from './document/live-doc.js'
import { createMaintenanceRouter } from './document/maintenance.js'
import { createDocumentMetadataRouter } from './document/metadata.js'
import { createRestoreRouter } from './document/restore.js'
import { createThumbnailsRouter } from './document/thumbnails.js'
import { createVersionsRouter } from './document/versions.js'
import { createWorkspacesRouter } from './document/workspaces.js'

export { createAutoVersionTrigger, setBroadcastFn }

export interface DocumentRouterOptions {
  // Allow tests to replace the store. Production uses FileVersionStore.
  versionStore?: VersionStore
  // Auto-version interval in milliseconds. Tests can reduce it.
  autoVersionIntervalMs?: number
  // Resolve the HEAD branch name for manual and auto version saves.
  // If omitted, ignore branch metadata. Production wires this from app.ts.
  getHeadBranch?: (workspaceId: string, path: string) => Promise<string | null>
}

// Entry point that composes the canvas API's sub-routers: workspace/canvas
// CRUD, names/pin metadata, the live-doc snapshot+update path, version
// history (list/save/thumbnails/restore), and maintenance (compact/prune/
// optimize). Split by concern so each is independently testable; this file
// only wires shared dependencies (versionStore, auto-version trigger,
// auto-compact) between them.
export function createDocumentRouter(options: DocumentRouterOptions = {}) {
  const app = new Hono()
  const versionStore = options.versionStore ?? new FileVersionStore()
  const autoInterval = options.autoVersionIntervalMs ?? AUTO_VERSION_INTERVAL_MS
  const triggerAutoVersion = createAutoVersionTrigger(
    versionStore,
    autoInterval,
    options.getHeadBranch,
  )
  // Register the same trigger with ws.ts so the WS path shares the auto-version logic.
  // Use dynamic import to avoid the ws.ts <- canvas.ts cycle evaluating in the wrong order.
  void import('./ws.js').then(({ setAutoVersionTrigger }) => {
    setAutoVersionTrigger?.(triggerAutoVersion)
  })

  // Auto-compact debounce: every successful saveDocument reschedules a per-
  // canvas compaction. The 30s default lets active editing sessions burst
  // without thrashing the op-log; once the user pauses, the shallow-snapshot
  // runs in the background. A test that wants the save path isolated from the
  // compact path calls `uninstallAutoCompact()`.
  installAutoCompact(versionStore)

  app.route('/', createWorkspacesRouter())
  app.route('/', createDocumentMetadataRouter())
  app.route('/', createLiveDocRouter({ triggerAutoVersion }))
  app.route('/', createVersionsRouter({ versionStore, getHeadBranch: options.getHeadBranch }))
  app.route('/', createMaintenanceRouter({ versionStore }))
  app.route('/', createDocumentSvgExportRouter())
  app.route('/', createThumbnailsRouter({ versionStore }))
  app.route('/', createRestoreRouter({ versionStore }))

  return app
}
