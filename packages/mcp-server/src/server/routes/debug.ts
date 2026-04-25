import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { listSessions, listCanvases, loadCanvas } from '../store/canvas-store.js'
import { getCacheKeys, peekDoc } from '../store/doc-cache.js'
import { isAuthorized } from './auth.js'

type CanvasInfo = {
  slug: string
  totalElements: number
  visibleElements: number
  tombstones: number
  cached: boolean
}

type SessionInfo = {
  sessionId: string
  daemonAlive: boolean
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

async function summarizeCanvas(
  sessionId: string,
  slug: string,
): Promise<CanvasInfo> {
  const cached = peekDoc(sessionId, slug)
  const doc = cached ?? (await loadCanvas(sessionId, slug))
  const counts = countElements(doc)
  return {
    slug,
    ...counts,
    cached: cached !== undefined,
  }
}

export interface CreateDebugRouterOptions {
  token?: string
}

export function createDebugRouter(options: CreateDebugRouterOptions = {}) {
  const app = new Hono()

  app.use('/api/debug', async (c, next) => {
    if (!isAuthorized(c.req.header('authorization'), options.token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  })

  app.get('/api/debug', async (c) => {
    const sessions = await listSessions()
    const sessionInfos: SessionInfo[] = await Promise.all(
      sessions.map(async ({ sessionId, daemonAlive }) => {
        const canvases = await listCanvases(sessionId)
        const canvasInfos = await Promise.all(
          canvases.map(({ slug }) => summarizeCanvas(sessionId, slug)),
        )
        return { sessionId, daemonAlive, canvases: canvasInfos }
      }),
    )

    const keys = getCacheKeys()
    return c.json({
      sessions: sessionInfos,
      cache: { size: keys.length, keys },
    })
  })

  return app
}
