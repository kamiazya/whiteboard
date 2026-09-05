import type { UpdateDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { resolveWorkspaceDocumentById } from '@kamiazya/whiteboard-loro-adapter'
import { applyWorkspaceDocumentUpdate, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LoroDoc } from 'loro-crdt'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import { getLogger } from '../../log.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'

// Same ceiling as the per-document update path: a workspace-granularity
// update carries the same kind of Loro delta, just scoped wider.
const WORKSPACE_DOC_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024

export interface WorkspaceDocumentRouterOptions {
  triggerAutoVersion: (workspaceId: string, path: string, doc: LoroDoc) => void
  // The workspace-document seam the routes read and write through.
  // Production wires this from document.ts; a router built without it falls
  // back to the same wiring via getDefaultServerDeps.
  serverDeps?: ServerDeps
}

// The workspace-granularity sync surface (order 7 of the workspace-document
// design): one snapshot/update pair for the whole workspace document. The
// protocol already carried a docRef per message; what changes here is only
// the granularity of the subscription.
//
// Translation-only adapters (ADR-0018): the reads go through the
// WorkspaceDocuments seam, and the update path — lock bracket, import,
// persist, projection eviction — lives in server-core's
// applyWorkspaceDocumentUpdate.
//
// GET  /api/w/:workspaceId/workspace-document/snapshot
// POST /api/w/:workspaceId/workspace-document/update?documentId=<ulid>
export function createWorkspaceDocumentRouter(options: WorkspaceDocumentRouterOptions) {
  const app = new Hono()
  const depsOf = async (): Promise<ServerDeps> =>
    options.serverDeps ?? (await getDefaultServerDeps())

  app.get('/api/w/:workspaceId/workspace-document/snapshot', async (c) => {
    const handle = c.req.param('workspaceId')
    try {
      validateWorkspaceId(handle)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json({ title: body.message }, 400)
      throw err
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    const deps = await depsOf()
    // Same honesty rule as the per-document snapshot: an unregistered
    // workspace is a refusal, not a phantom. Inside a registered workspace,
    // a missing workspace document is minted empty — the workspace is real,
    // it just has no tree-plane documents yet.
    if (!(await deps.workspaceDocuments.exists(workspaceId))) {
      return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
    }
    const doc = await deps.workspaceDocuments.get(workspaceId)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array<ArrayBuffer>
    return c.body(snapshot, 200, { 'Content-Type': 'application/octet-stream' })
  })

  app.post(
    '/api/w/:workspaceId/workspace-document/update',
    bodyLimit({
      maxSize: WORKSPACE_DOC_UPDATE_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          {
            error: 'payload_too_large',
            message: `Update exceeds ${WORKSPACE_DOC_UPDATE_LIMIT_BYTES} bytes limit.`,
          },
          413,
        ),
    }),
    async (c) => {
      const handle = c.req.param('workspaceId')
      try {
        validateWorkspaceId(handle)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json({ title: body.message }, 400)
        throw err
      }
      const workspaceId = await workspaceIdFromHandle(c, handle)
      const deps = await depsOf()
      if (!(await deps.workspaceDocuments.exists(workspaceId))) {
        return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer())

      const result = await applyWorkspaceDocumentUpdate(deps, { workspaceId, update: bytes })
      if (result === 'malformed-update') {
        return c.json({ title: 'Malformed workspace-document update' }, 400)
      }

      // Signal the document the client says it is editing. The checkpoint
      // lands once it goes quiet; failures never fail the update itself.
      const documentId = c.req.query('documentId')
      if (documentId !== undefined) {
        void (async () => {
          const workspaceDoc = await deps.workspaceDocuments.get(workspaceId)
          const entry = resolveWorkspaceDocumentById(workspaceDoc, documentId)
          if (entry === null) return
          const doc = await deps.liveDocuments.get(workspaceId, entry.path)
          options.triggerAutoVersion(workspaceId, entry.path, doc)
        })().catch((err: unknown) => {
          getLogger('document').error({ err: err as Error }, 'auto-version trigger failed')
        })
      }

      const response: UpdateDocumentResponse = { ok: true }
      return c.json(response)
    },
  )

  return app
}
