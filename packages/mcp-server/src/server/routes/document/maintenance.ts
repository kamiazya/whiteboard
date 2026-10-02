import type {
  CompactWorkspaceResult,
  PruneSandwichedVersionsResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { Hono } from 'hono'
import { compactWorkspace, listDocuments } from '../../store/document-store.js'
import type { VersionStore } from '../../store/version-store.js'
import { parseWorkspaceHandle } from '../../workspace-handle.js'
import { handleCorruptStoredData } from './_shared.js'

export interface MaintenanceRouterOptions {
  versionStore: VersionStore
}

// POST /api/workspaces/:workspaceId/versions/prune-sandwiched
// POST /api/workspaces/:workspaceId/documents/optimize-all
export function createMaintenanceRouter(options: MaintenanceRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  // Drop auto-saved versions strictly between two manual versions, per
  // document. Manuals are explicit user save-points; sandwiched autos add no
  // rollback value once both bracket points exist. Loops over every document
  // in the workspace and aggregates totals.
  app.post('/api/workspaces/:workspaceId/versions/prune-sandwiched', async (c) => {
    const address = await parseWorkspaceHandle(c, c.req.param('workspaceId'))
    if ('refusal' in address) return address.refusal
    const { workspaceId } = address
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

  // Compact the workspace record: every document in the workspace lives in
  // it, so "optimize all" is ONE fold of its op-log, and the answer is that
  // fold's result. No cache eviction afterwards — the fold exports from the
  // live workspace document and writes its own frontier back, so the cached
  // instance and its per-document projections stay coherent with the store.
  app.post('/api/workspaces/:workspaceId/documents/optimize-all', async (c) => {
    const address = await parseWorkspaceHandle(c, c.req.param('workspaceId'))
    if ('refusal' in address) return address.refusal
    const { workspaceId } = address
    try {
      const result: CompactWorkspaceResult = await compactWorkspace(workspaceId, versionStore)
      return c.json(result)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
