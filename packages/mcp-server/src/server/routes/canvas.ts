import { Hono } from 'hono'
import { scheduleAutoCompact, setAutoCompactTrigger } from '../store/canvas-store.js'
import { FileVersionStore, type VersionStore } from '../store/version-store.js'
import { AUTO_VERSION_INTERVAL_MS, createAutoVersionTrigger } from './canvas/auto-version.js'
import { createCanvasJsonExportRouter } from './canvas/export-json.js'
import { createCanvasSvgExportRouter } from './canvas/export-svg.js'
import { createLiveDocRouter } from './canvas/live-doc.js'
import { createMaintenanceRouter } from './canvas/maintenance.js'
import { createCanvasMetadataRouter } from './canvas/metadata.js'
import { createRestoreRouter } from './canvas/restore.js'
import { setBroadcastFn } from './canvas/shared.js'
import { createThumbnailsRouter } from './canvas/thumbnails.js'
import { createVersionsRouter } from './canvas/versions.js'
import { createWorkspacesRouter } from './canvas/workspaces.js'

export { createAutoVersionTrigger, setBroadcastFn }

export interface CanvasRouterOptions {
  // Allow tests to replace the store. Production uses FileVersionStore.
  versionStore?: VersionStore
  // Auto-version interval in milliseconds. Tests can reduce it.
  autoVersionIntervalMs?: number
  // Resolve the HEAD branch name for manual and auto version saves.
  // If omitted, ignore branch metadata. Production wires this from app.ts.
  getHeadBranch?: (workspaceId: string, slug: string) => Promise<string | null>
}

// Entry point that composes the canvas API's sub-routers: workspace/canvas
// CRUD, names/pin metadata, the live-doc snapshot+update path, version
// history (list/save/thumbnails/restore), and maintenance (compact/prune/
// optimize). Split by concern so each is independently testable; this file
// only wires shared dependencies (versionStore, auto-version trigger,
// auto-compact) between them.
export function createCanvasRouter(options: CanvasRouterOptions = {}) {
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

  // Auto-compact debounce: every successful saveCanvas reschedules a per-
  // canvas compaction. The 30s default lets active editing sessions burst
  // without thrashing the op-log; once the user pauses, the shallow-snapshot
  // runs in the background. Tests can override the trigger via
  // setAutoCompactTrigger(null) before assertions if they want to isolate
  // the save path from the compact path.
  setAutoCompactTrigger((workspaceId, slug) => {
    scheduleAutoCompact(workspaceId, slug, versionStore)
  })

  app.route('/', createWorkspacesRouter())
  app.route('/', createCanvasMetadataRouter())
  app.route('/', createLiveDocRouter({ triggerAutoVersion }))
  app.route('/', createVersionsRouter({ versionStore, getHeadBranch: options.getHeadBranch }))
  app.route('/', createMaintenanceRouter({ versionStore }))
  app.route('/', createCanvasJsonExportRouter())
  app.route('/', createCanvasSvgExportRouter())
  app.route('/', createThumbnailsRouter({ versionStore }))
  app.route('/', createRestoreRouter({ versionStore }))

  return app
}
