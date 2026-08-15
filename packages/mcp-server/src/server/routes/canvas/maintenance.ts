import { Hono } from 'hono'
import { compactCanvas, listCanvases } from '../../store/canvas-store.js'
import { evictDoc } from '../../store/doc-cache.js'
import type { VersionStore } from '../../store/version-store.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { handleCorruptStoredData } from './_shared.js'
import { onCanvasesRoute } from './path-route.js'

export interface MaintenanceRouterOptions {
  versionStore: VersionStore
}

// POST /api/workspaces/:workspaceId/canvases/:slug/compact
// POST /api/workspaces/:workspaceId/versions/prune-sandwiched
// POST /api/workspaces/:workspaceId/canvases/optimize-all
export function createMaintenanceRouter(options: MaintenanceRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  // GC the op-log before the oldest retained version frontiers using shallow-snapshot.
  // Side effects: replace the on-disk .loro file and evict doc-cache so the next getDoc reloads the shallow doc.
  // Avoid calling this frequently on highly active multi-peer canvases because concurrent applyAndPersist calls can race.
  onCanvasesRoute(app, 'post', ['compact'], async (c, workspaceId, slug) => {
    try {
      const result = await compactCanvas(workspaceId, slug, versionStore)
      if (result.compacted) evictDoc(workspaceId, slug)
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
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const canvases = await listCanvases(workspaceId)
      const results: Array<{ slug: string; deletedCount: number }> = []
      let totalDeleted = 0
      for (const { slug } of canvases) {
        const r = await versionStore.pruneSandwichedAutoVersions(workspaceId, slug)
        results.push({ slug, deletedCount: r.deletedCount })
        totalDeleted += r.deletedCount
      }
      return c.json({ results, totalDeleted })
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
  app.post('/api/workspaces/:workspaceId/canvases/optimize-all', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const canvases = await listCanvases(workspaceId)
      const results: Array<{
        slug: string
        compacted: boolean
        beforeBytes: number
        afterBytes: number
        reason?: string
      }> = []
      let totalBeforeBytes = 0
      let totalAfterBytes = 0
      for (const { slug } of canvases) {
        const result = await compactCanvas(workspaceId, slug, versionStore)
        if (result.compacted) evictDoc(workspaceId, slug)
        results.push({ slug, ...result })
        totalBeforeBytes += result.beforeBytes
        totalAfterBytes += result.afterBytes
      }
      return c.json({ results, totalBeforeBytes, totalAfterBytes })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
