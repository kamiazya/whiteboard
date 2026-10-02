import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import type { RestoreProgress, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import type { FirstMember, WorkspaceAdmit } from '../security/membership-gate.js'
import { installAutoCheckpoint } from '../store/auto-checkpoint.js'
import { FileVersionStore, type VersionStore } from '../store/version-store.js'
import { type AutoVersionTrigger, createAutoVersionTrigger } from './document/auto-version.js'
import { createDocumentSvgExportRouter } from './document/export-svg.js'
import { createLiveDocRouter } from './document/live-doc.js'
import { createMaintenanceRouter } from './document/maintenance.js'
import { createDocumentMetadataRouter } from './document/metadata.js'
import { createRestoreRouter } from './document/restore.js'
import { createTrashRouter } from './document/trash.js'
import { createVersionsRouter } from './document/versions.js'
import { createWorkspaceDocumentRouter } from './document/workspace-document.js'
import { createWorkspacesRouter } from './document/workspaces.js'
import { sendRestoreEvent, sendVersionCreated } from './sync-audience.js'

export type { AutoVersionTrigger }
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
  // The operations the routes below adapt onto (ADR-0018), handed down from
  // app.ts. Required: a router that composed its own would be a second
  // composition path, and the one it built carried none of what the root
  // attaches.
  serverDeps: ServerDeps
  /**
   * Hands the caller the checkpoint trigger this router created, so a
   * composition root can flush it when the process is going away.
   *
   * The trigger is a TRAILING debounce, which makes an unflushed shutdown
   * lose exactly the checkpoint it exists to take: the one at the pause where
   * editing stopped. Nothing else in this router outlives a request, so this
   * is the one thing a lifetime has to reach into it for. Called
   * synchronously during construction, so a root that arms its background
   * work after `createApp` already holds it.
   */
  onAutoVersionTrigger?: (trigger: AutoVersionTrigger) => void
  /** This daemon as an OKF actor — see `VersionsRouterOptions.daemonActor`. */
  daemonActor?: string
  /** Resolves the read plane's effective tier for GET /api/workspaces to
   *  echo per row (ADR-0042 decisions 1/3/5). Absent means the listing omits
   *  `tier` entirely — see `WorkspacesRouterOptions`. */
  replicaTier?: (workspaceId: string) => Promise<ReplicaTier>
  /** S8 slice 2: threaded to `createWorkspacesRouter` — see its own doc. */
  admit?: WorkspaceAdmit
  /** Threaded to `createWorkspacesRouter` — see its own doc. */
  firstMember?: FirstMember
}

// The checkpoint trigger both the HTTP and the WS update paths fire.
function armAutoVersionTrigger(
  options: DocumentRouterOptions,
  versionStore: VersionStore,
): AutoVersionTrigger {
  const trigger = createAutoVersionTrigger(versionStore, {
    ...(options.autoVersionQuietMs === undefined ? {} : { quietMs: options.autoVersionQuietMs }),
    ...(options.daemonActor === undefined ? {} : { daemonActor: options.daemonActor }),
    // The checkpoint lands long after the update that signalled it, so the
    // broadcast is the trigger's to make rather than the caller's.
    onSaved: (workspaceId, path, entry) => {
      sendVersionCreated(workspaceId, path, entry)
    },
  })
  // The agent write path signals this same scheduler, so an agent-only
  // workspace gets the checkpoints (and the compaction floor) an edited one does.
  installAutoCheckpoint(trigger)
  options.onAutoVersionTrigger?.(trigger)
  return trigger
}

// Entry point that composes the canvas API's sub-routers: workspace/canvas
// CRUD, names/pin metadata, the live-doc snapshot+update path, version
// history (list/save/thumbnails/restore), and maintenance (compact/prune/
// optimize). Split by concern so each is independently testable; this file
// only wires shared dependencies (versionStore, auto-version trigger) between
// them. Auto-compaction is armed by the composition root's background work
// (`shared-background-work.ts`), not here.
export function createDocumentRouter(options: DocumentRouterOptions) {
  const app = new Hono()
  const versionStore = options.versionStore ?? new FileVersionStore()
  const triggerAutoVersion = armAutoVersionTrigger(options, versionStore)

  app.route(
    '/',
    createWorkspacesRouter({
      serverDeps: options.serverDeps,
      ...(options.replicaTier === undefined ? {} : { replicaTier: options.replicaTier }),
      ...(options.admit === undefined ? {} : { admit: options.admit }),
      ...(options.firstMember === undefined ? {} : { firstMember: options.firstMember }),
    }),
  )
  app.route('/', createTrashRouter({ serverDeps: options.serverDeps }))
  app.route('/', createDocumentMetadataRouter())
  app.route('/', createLiveDocRouter({ triggerAutoVersion, serverDeps: options.serverDeps }))
  app.route(
    '/',
    createWorkspaceDocumentRouter({
      triggerAutoVersion,
      serverDeps: options.serverDeps,
      ...(options.daemonActor === undefined ? {} : { daemonActor: options.daemonActor }),
    }),
  )
  app.route(
    '/',
    createVersionsRouter({
      versionStore,
      ...(options.daemonActor === undefined ? {} : { daemonActor: options.daemonActor }),
    }),
  )
  app.route('/', createMaintenanceRouter({ versionStore }))
  app.route('/', createDocumentSvgExportRouter({ liveDocuments: options.serverDeps.liveDocuments }))
  const restoreProgress: RestoreProgress = async (event) => {
    sendRestoreEvent(event.workspaceId, event.path, event.phase, event.label)
  }
  app.route(
    '/',
    createRestoreRouter({
      versionStore,
      serverDeps: options.serverDeps,
      progress: restoreProgress,
    }),
  )

  return app
}
