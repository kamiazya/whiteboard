import { Hono } from 'hono'
import type { LoroDoc } from 'loro-crdt'
import { listCanvases, listWorkspaces, loadCanvas } from '../store/canvas-store.js'
import { countAliveNodes } from '../store/count-alive-nodes.js'
import { getCacheKeys, peekDoc } from '../store/doc-cache.js'
import { isAuthorized } from './auth.js'

type CanvasInfo = {
  slug: string
  totalElements: number
  visibleElements: number
  tombstones: number
  cached: boolean
}

type WorkspaceInfo = {
  workspaceId: string
  canvases: CanvasInfo[]
}

// Legacy 'elements' movable-list entries never get pruned, only tombstoned
// (isDeleted=true) -- so a tombstone count is legacy-list-only by
// definition; a nodes-model doc has none, since deleteSpatialNode removes
// the entry outright rather than marking it dead.
function countLegacyTombstones(doc: LoroDoc): number {
  const list = doc.getMovableList('elements').toJSON() as Array<{ isDeleted?: boolean }>
  return list.filter((el) => el?.isDeleted === true).length
}

async function summarizeCanvas(workspaceId: string, slug: string): Promise<CanvasInfo> {
  const cached = peekDoc(workspaceId, slug)
  const doc = cached ?? (await loadCanvas(workspaceId, slug))
  const visibleElements = countAliveNodes(doc)
  const tombstones = countLegacyTombstones(doc)
  return {
    slug,
    totalElements: visibleElements + tombstones,
    visibleElements,
    tombstones,
    cached: cached !== undefined,
  }
}

export interface CreateDebugRouterOptions {
  token?: string
  enabled?: boolean
}

export function createDebugRouter(options: CreateDebugRouterOptions = {}) {
  const app = new Hono()
  const enabled = options.enabled ?? process.env.WHITEBOARD_DEBUG === '1'

  if (!enabled) {
    app.all('/api/debug', (c) => c.notFound())
    return app
  }

  app.use('/api/debug', async (c, next) => {
    if (!isAuthorized(c.req.header('authorization'), options.token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  })

  app.get('/api/debug', async (c) => {
    const workspaces = await listWorkspaces()
    const workspaceInfos: WorkspaceInfo[] = await Promise.all(
      workspaces.map(async ({ workspaceId }) => {
        const canvases = await listCanvases(workspaceId)
        const canvasInfos = await Promise.all(
          canvases.map(({ slug }) => summarizeCanvas(workspaceId, slug)),
        )
        return { workspaceId, canvases: canvasInfos }
      }),
    )

    const keys = getCacheKeys()
    return c.json({
      workspaces: workspaceInfos,
      cache: { size: keys.length, keys },
    })
  })

  return app
}
