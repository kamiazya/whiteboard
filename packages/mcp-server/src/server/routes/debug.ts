import { Hono } from 'hono'
import { type LoroDoc, LoroMap } from 'loro-crdt'
import { listCanvases, listWorkspaces, loadCanvas } from '../store/canvas-store.js'
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

function countElements(doc: LoroDoc): {
  totalElements: number
  visibleElements: number
  tombstones: number
} {
  const list = doc.getMovableList('elements')
  let total = 0
  let tombstones = 0
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i)
    if (!(item instanceof LoroMap)) continue
    total += 1
    if (item.get('isDeleted') === true) tombstones += 1
  }
  return { totalElements: total, visibleElements: total - tombstones, tombstones }
}

async function summarizeCanvas(workspaceId: string, slug: string): Promise<CanvasInfo> {
  const cached = peekDoc(workspaceId, slug)
  const doc = cached ?? (await loadCanvas(workspaceId, slug))
  const counts = countElements(doc)
  return {
    slug,
    ...counts,
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
