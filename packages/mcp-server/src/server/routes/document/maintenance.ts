import type {
  OptimizeAllDocumentsResponse,
  PruneSandwichedVersionsResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { Hono } from 'hono'
import { evictDoc } from '../../store/doc-cache.js'
import { compactDocument, listDocuments } from '../../store/document-store.js'
import type { VersionStore } from '../../store/version-store.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'
import { handleCorruptStoredData } from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

export interface MaintenanceRouterOptions {
  versionStore: VersionStore
}

// POST /api/workspaces/:workspaceId/documents/:path/compact
// POST /api/workspaces/:workspaceId/versions/prune-sandwiched
// POST /api/workspaces/:workspaceId/documents/optimize-all
export function createMaintenanceRouter(options: MaintenanceRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  // GC the op-log before the oldest retained version frontiers using shallow-snapshot.
  // Side effects: replace the on-disk .loro file and evict doc-cache so the next getDoc reloads the shallow doc.
  // Avoid calling this frequently on highly active multi-peer documents because concurrent saves can race.
  onDocumentsRoute(app, 'post', ['compact'], async (c, workspaceId, path) => {
    try {
      const result = await compactDocument(workspaceId, path, versionStore)
      if (result.compacted) evictDoc(workspaceId, path)
      return c.json(result)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // Drop auto-saved versions strictly between two manual versions, per
  // canvas, per branch. Manuals are explicit user save-points; sandwiched
  // autos add no rollback value once both bracket points exist. Loops over
  // every canvas in the workspace and aggregates totals.
  app.post('/api/workspaces/:workspaceId/versions/prune-sandwiched', async (c) => {
    const handle = c.req.param('workspaceId')
    try {
      validateWorkspaceId(handle)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    try {
      const documents = await listDocuments(workspaceId)
      const results: Array<{ path: string; deletedCount: number }> = []
      let totalDeleted = 0
      for (const { path } of documents) {
        const r = await versionStore.pruneSandwichedAutoVersions(workspaceId, path)
        results.push({ path, deletedCount: r.deletedCount })
        totalDeleted += r.deletedCount
      }
      // Bound to the contract the Storage tab hard-parses; `results` rides
      // along deliberately unvalidated (see the schema's comment).
      return c.json({ results, totalDeleted } satisfies PruneSandwichedVersionsResponse & {
        results: unknown
      })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // Bulk per-canvas compact for the whole workspace. Loops sequentially to
  // keep the doc-cache coherent (each compact evicts its own slot) and
  // because the underlying Loro IO is fast enough that parallelism only
  // adds race risk. Returns a per-canvas array plus aggregated totals so
  // the UI can show a meaningful summary in one round-trip.
  app.post('/api/workspaces/:workspaceId/documents/optimize-all', async (c) => {
    const handle = c.req.param('workspaceId')
    try {
      validateWorkspaceId(handle)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    try {
      const documents = await listDocuments(workspaceId)
      const results: Array<{
        path: string
        compacted: boolean
        beforeBytes: number
        afterBytes: number
        reason?: string
      }> = []
      let totalBeforeBytes = 0
      let totalAfterBytes = 0
      for (const { path } of documents) {
        const result = await compactDocument(workspaceId, path, versionStore)
        if (result.compacted) evictDoc(workspaceId, path)
        results.push({ path, ...result })
        totalBeforeBytes += result.beforeBytes
        totalAfterBytes += result.afterBytes
      }
      return c.json({
        results,
        totalBeforeBytes,
        totalAfterBytes,
      } satisfies OptimizeAllDocumentsResponse & { results: unknown })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
