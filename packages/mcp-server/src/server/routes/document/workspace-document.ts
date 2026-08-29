import { resolveWorkspaceDocumentById } from '@kamiazya/whiteboard-loro-adapter'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LoroDoc } from 'loro-crdt'
import type { UpdateDocumentResponse } from '../../../shared/api-contracts/document.js'
import { getLogger } from '../../log.js'
import { evictWorkspaceDocs } from '../../store/doc-cache.js'
import {
  getDoc,
  getWorkspaceDoc,
  saveWorkspaceDoc,
  workspaceExists,
} from '../../store/document-store.js'
import type { VersionEntry } from '../../store/version-store.js'
import { withWorkspaceWriteLock } from '../../store/workspace-lock.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'

// Same ceiling as the per-document update path: a workspace-granularity
// update carries the same kind of Loro delta, just scoped wider.
const WORKSPACE_DOC_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024

export interface WorkspaceDocumentRouterOptions {
  triggerAutoVersion: (
    workspaceId: string,
    path: string,
    doc: LoroDoc,
  ) => Promise<VersionEntry | null>
}

// The workspace-granularity sync surface (order 7 of the workspace-document
// design): one snapshot/update pair for the whole workspace document. The
// protocol already carried a docRef per message; what changes here is only
// the granularity of the subscription.
//
// GET  /api/w/:workspaceId/workspace-document/snapshot
// POST /api/w/:workspaceId/workspace-document/update?documentId=<ulid>
export function createWorkspaceDocumentRouter(options: WorkspaceDocumentRouterOptions) {
  const app = new Hono()

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
    // Same honesty rule as the per-document snapshot: an unregistered
    // workspace is a refusal, not a phantom. Inside a registered workspace,
    // a missing workspace document is minted empty — the workspace is real,
    // it just has no tree-plane documents yet.
    if (!(await workspaceExists(workspaceId))) {
      return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
    }
    const doc = await getWorkspaceDoc(workspaceId)
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
      if (!(await workspaceExists(workspaceId))) {
        return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer())

      // Import + persist under the workspace write lock so a concurrent
      // per-document save (which projects, diffs, and writes through the
      // same live workspace document) settles into a definite order.
      const imported = await withWorkspaceWriteLock(workspaceId, async () => {
        const doc = await getWorkspaceDoc(workspaceId)
        try {
          doc.import(bytes)
        } catch (err: unknown) {
          getLogger('document').warning(
            { workspaceId, updateBytes: bytes.byteLength, err },
            'workspace-document update rejected: malformed Loro import data',
          )
          return false
        }
        // Fan-out to subscribers happens inside saveWorkspaceDoc.
        await saveWorkspaceDoc(workspaceId, doc)
        // Every cached per-document projection of this workspace is now
        // stale; a stale one would diff old content back over this import
        // on its next save. Dropped inside the lock so no reader can grab
        // a stale projection between the import and the eviction.
        evictWorkspaceDocs(workspaceId)
        return true
      })
      if (!imported) {
        return c.json({ title: 'Malformed workspace-document update' }, 400)
      }

      // Auto-version for the document the client says it is editing. The
      // trigger is throttled; failures never fail the update itself.
      const documentId = c.req.query('documentId')
      if (documentId !== undefined) {
        void (async () => {
          const workspaceDoc = await getWorkspaceDoc(workspaceId)
          const entry = resolveWorkspaceDocumentById(workspaceDoc, documentId)
          if (entry === null) return
          const doc = await getDoc(workspaceId, entry.path)
          const version = await options.triggerAutoVersion(workspaceId, entry.path, doc)
          if (!version) return
          const { sendVersionCreated } = await import('../ws.js')
          sendVersionCreated(workspaceId, entry.path, version)
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
