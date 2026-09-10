import { countAliveNodes, countLegacyTombstones } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { isAuthorized } from '../security/bearer-token.js'
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
    // JSON, like every other refusal on this daemon's `/api/` surface: the
    // built-in 404 answers text/plain, so a caller parsing the body to find
    // out why gets a SyntaxError instead of the reason. The STATUS is
    // unchanged — an endpoint that is not enabled is not there.
    app.all('/api/debug', (c) =>
      c.json({ error: 'not_found', message: 'Debug endpoint is not enabled' }, 404),
    )
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
