import { countSpatialNodes } from '@kamiazya/whiteboard-loro-adapter'
import { Hono } from 'hono'
import { getCacheKeys, peekDoc } from '../store/doc-cache.js'
import { listDocuments, listWorkspaces, loadDocument } from '../store/document-store.js'
import type { StoreScope } from '../store/store-scope.js'

type DocumentInfo = {
  path: string
  nodeCount: number
  cached: boolean
}

type WorkspaceInfo = {
  workspaceId: string
  documents: DocumentInfo[]
}

async function summarizeDocument(
  workspaceId: string,
  path: string,
  scope: StoreScope,
): Promise<DocumentInfo> {
  const cached = peekDoc(workspaceId, path, scope)
  const doc = cached ?? (await loadDocument(workspaceId, path, scope))
  return {
    path,
    nodeCount: countSpatialNodes(doc),
    cached: cached !== undefined,
  }
}

// Who may read the dump is the route-scope registry's `daemon-token-only`
// decision, enforced by the /api/* middleware in front of this router — so
// this file decides only whether the endpoint exists.
export interface CreateDebugRouterOptions {
  /** The directory whose workspaces, documents and cache the dump describes. */
  scope: StoreScope
  enabled?: boolean
}

export function createDebugRouter(options: CreateDebugRouterOptions) {
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

  app.get('/api/debug', async (c) => {
    const workspaces = await listWorkspaces(options.scope)
    const workspaceInfos: WorkspaceInfo[] = await Promise.all(
      workspaces.map(async ({ workspaceId }) => {
        const documents = await listDocuments(workspaceId, options.scope)
        const canvasInfos = await Promise.all(
          documents.map(({ path }) => summarizeDocument(workspaceId, path, options.scope)),
        )
        return { workspaceId, documents: canvasInfos }
      }),
    )

    const keys = getCacheKeys(options.scope)
    return c.json({
      workspaces: workspaceInfos,
      cache: { size: keys.length, keys },
    })
  })

  return app
}
