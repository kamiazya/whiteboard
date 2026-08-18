import { Hono } from 'hono'
import { isAuthorized } from '../security/bearer-token.js'
import { countAliveNodes, countLegacyTombstones } from '../store/count-alive-nodes.js'
import { getCacheKeys, peekDoc } from '../store/doc-cache.js'
import { listDocuments, listWorkspaces, loadDocument } from '../store/document-store.js'

type DocumentInfo = {
  path: string
  totalElements: number
  visibleElements: number
  tombstones: number
  cached: boolean
}

type WorkspaceInfo = {
  workspaceId: string
  documents: DocumentInfo[]
}

async function summarizeCanvas(workspaceId: string, path: string): Promise<DocumentInfo> {
  const cached = peekDoc(workspaceId, path)
  const doc = cached ?? (await loadDocument(workspaceId, path))
  const visibleElements = countAliveNodes(doc)
  const tombstones = countLegacyTombstones(doc)
  return {
    path,
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
        const documents = await listDocuments(workspaceId)
        const canvasInfos = await Promise.all(
          documents.map(({ path }) => summarizeCanvas(workspaceId, path)),
        )
        return { workspaceId, documents: canvasInfos }
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
