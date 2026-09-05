/**
 * The trash surface: list what deletes evacuated, restore one entry.
 *
 * An ADAPTER over the deps' trash seam (ADR-0018): the evacuate/restore
 * mechanics live in workspace-index behind `ServerDeps.trash`, and all this
 * translates is the ADDRESS (workspaceId + documentId in the URL) and the
 * absent cases — unknown workspace and unknown entry are both 404 here, a
 * composition with no trash capability is 501.
 */

import type {
  ListTrashResponse,
  RestoreTrashResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { ApiErrorBody } from '@kamiazya/whiteboard-daemon-client/api-contracts/errors'
import { isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import { getLogger } from '../../log.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'

export interface TrashRouterOptions {
  serverDeps?: ServerDeps
}

export function createTrashRouter(options: TrashRouterOptions = {}): Hono {
  const app = new Hono()

  const depsOf = async () => options.serverDeps ?? (await getDefaultServerDeps())

  app.get('/api/workspaces/:workspaceId/trash', async (c) => {
    const handle = c.req.param('workspaceId')
    // A malformed address is the caller's error, not this server's — kept
    // outside the try below so it cannot fall through to the 500 arm.
    try {
      validateWorkspaceId(handle)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    try {
      const deps = await depsOf()
      if (deps.trash === undefined) {
        return c.json({ title: 'This composition has no trash.' } satisfies ApiErrorBody, 501)
      }
      // The trash lives in the workspace record; an unknown workspace has no
      // record to open, which the seam refuses — translated to 404 below.
      // A known-but-empty trash is an empty list, never an error.
      const entries = await deps.trash.list({ workspaceId })
      const response: ListTrashResponse = {
        entries: entries.map((entry) => ({
          documentId: entry.documentId,
          path: entry.path,
          deletedAt: entry.deletedAt,
        })),
      }
      return c.json(response)
    } catch (err) {
      if (isWorkspaceNotFoundError(err)) {
        return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
      }
      getLogger('document').error({ err: err as Error }, 'trash list failed unexpectedly')
      return c.json({ title: 'Failed to list the trash.' } satisfies ApiErrorBody, 500)
    }
  })

  app.post('/api/workspaces/:workspaceId/trash/:documentId/restore', async (c) => {
    const handle = c.req.param('workspaceId')
    const documentId = c.req.param('documentId')
    try {
      validateWorkspaceId(handle)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    try {
      const deps = await depsOf()
      if (deps.trash === undefined) {
        return c.json({ title: 'This composition has no trash.' } satisfies ApiErrorBody, 501)
      }
      const restored = await deps.trash.restore({ workspaceId, documentId })
      // null covers both "never in the trash" and "entry present but the
      // evacuated bytes are gone" — either way there is nothing to bring
      // back, and inventing a distinction here would promise recovery the
      // store cannot deliver.
      if (restored === null) {
        return c.json({ title: `Nothing restorable for "${documentId}"` }, 404)
      }
      const response: RestoreTrashResponse = {
        restored: { documentId: restored.documentId, path: restored.path },
      }
      return c.json(response)
    } catch (err) {
      if (isWorkspaceNotFoundError(err)) {
        return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
      }
      getLogger('document').error({ err: err as Error }, 'trash restore failed unexpectedly')
      return c.json({ title: 'Failed to restore from the trash.' } satisfies ApiErrorBody, 500)
    }
  })

  return app
}
