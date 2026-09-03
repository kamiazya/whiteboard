import type { RestoreProgress, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getLogger } from '../log.js'
import { installAutoCompact } from '../store/auto-compact.js'
import { FileVersionStore, type VersionStore } from '../store/version-store.js'
import { createAutoVersionTrigger } from './document/auto-version.js'
import { createDocumentSvgExportRouter } from './document/export-svg.js'
import { createLiveDocRouter } from './document/live-doc.js'
import { createMaintenanceRouter } from './document/maintenance.js'
import { createDocumentMetadataRouter } from './document/metadata.js'
import { createRestoreRouter } from './document/restore.js'
import { createThumbnailsRouter } from './document/thumbnails.js'
import { createTrashRouter } from './document/trash.js'
import { createVersionsRouter } from './document/versions.js'
import { createWorkspaceDocumentRouter } from './document/workspace-document.js'
import { createWorkspacesRouter } from './document/workspaces.js'

export { createAutoVersionTrigger }

export interface DocumentRouterOptions {
  // Allow tests to replace the store. Production uses FileVersionStore.
  versionStore?: VersionStore
  // Auto-version interval in milliseconds. Tests can reduce it.
  /**
   * The pause after which a document's automatic checkpoint is taken. Tests
   * that want no checkpoint at all pass a value longer than they run.
   */
  autoVersionQuietMs?: number
  // Resolve the HEAD branch name for manual and auto version saves.
  // If omitted, ignore branch metadata. Production wires this from app.ts.
  getHeadBranch?: (workspaceId: string, path: string) => Promise<string | null>
  // The operations the routes below adapt onto (ADR-0018). Production wires
  // this from app.ts; see `getDefaultServerDeps` for what a caller that
  // omits it gets, which is the same wiring rather than a stand-in.
  serverDeps?: ServerDeps
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
  const triggerAutoVersion = createAutoVersionTrigger(versionStore, {
    ...(options.autoVersionQuietMs === undefined ? {} : { quietMs: options.autoVersionQuietMs }),
    ...(options.getHeadBranch === undefined ? {} : { getHeadBranch: options.getHeadBranch }),
    // The checkpoint lands long after the update that signalled it, so the
    // broadcast is the trigger's to make rather than the caller's.
    onSaved: (workspaceId, path, entry) => {
      void import('./ws.js')
        .then(({ sendVersionCreated }) => sendVersionCreated(workspaceId, path, entry))
        .catch((err: unknown) => {
          getLogger('auto-version').error({ err: err as Error }, 'version_created broadcast failed')
        })
    },
  })
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

  app.route('/', createWorkspacesRouter({ serverDeps: options.serverDeps }))
  app.route('/', createTrashRouter({ serverDeps: options.serverDeps }))
  app.route('/', createDocumentMetadataRouter())
  app.route(
    '/',
    createLiveDocRouter({
      triggerAutoVersion,
      ...(options.serverDeps === undefined ? {} : { serverDeps: options.serverDeps }),
    }),
  )
  app.route(
    '/',
    createWorkspaceDocumentRouter({
      triggerAutoVersion,
      ...(options.serverDeps === undefined ? {} : { serverDeps: options.serverDeps }),
    }),
  )
  app.route('/', createVersionsRouter({ versionStore, getHeadBranch: options.getHeadBranch }))
  app.route('/', createMaintenanceRouter({ versionStore }))
  app.route('/', createDocumentSvgExportRouter())
  app.route('/', createThumbnailsRouter({ versionStore }))
  // Restore progress goes out over the WS surface; same dynamic import as
  // setAutoVersionTrigger above, for the same eval-order reason.
  const restoreProgress: RestoreProgress = async (event) => {
    const { sendRestoreEvent } = await import('./ws.js')
    sendRestoreEvent(event.workspaceId, event.path, event.phase, event.label)
  }
  app.route(
    '/',
    createRestoreRouter({
      versionStore,
      ...(options.serverDeps === undefined ? {} : { serverDeps: options.serverDeps }),
      progress: restoreProgress,
    }),
  )

  return app
}
