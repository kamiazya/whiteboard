/**
 * The trash surface: list what deletes evacuated, restore one entry, or
 * destroy one for good.
 *
 * An ADAPTER over the deps' trash seam (ADR-0018): the evacuate/restore
 * mechanics live in workspace-index behind `ServerDeps.trash`, and all this
 * translates is the ADDRESS (workspaceId + documentId in the URL) and the
 * absent cases — unknown workspace and unknown entry are both 404 here, a
 * composition with no trash capability is 501.
 */

import type {
  ListTrashResponse,
  PurgeTrashEntryResponse,
  RestoreTrashResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import type { ApiErrorBody, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { type Context, Hono } from 'hono'
import { getLogger } from '../../log.js'
import { parseWorkspaceHandle } from '../../workspace-handle.js'

export interface TrashRouterOptions {
  serverDeps: ServerDeps
}

type Handler = (c: Context) => Promise<Response>

const NO_TRASH: ApiErrorBody = { title: 'This composition has no trash.' }

// The addressing every trash route shares: the workspace handle parsed and
// refused outside the try below, the unknown workspace answered 404, anything
// else logged and answered 500.
async function answering(
  deps: ServerDeps,
  c: Context,
  failure: { readonly answered: string; readonly logged: string },
  body: (workspaceId: string, trash: NonNullable<ServerDeps['trash']>) => Promise<Response>,
): Promise<Response> {
  // A malformed address is the caller's error, not this server's — kept
  // outside the try below so it cannot fall through to the 500 arm.
  const address = await parseWorkspaceHandle(c, c.req.param('workspaceId') ?? '')
  if ('refusal' in address) return address.refusal
  const { workspaceId } = address
  try {
    if (deps.trash === undefined) return c.json(NO_TRASH, 501)
    return await body(workspaceId, deps.trash)
  } catch (err) {
    if (isWorkspaceNotFoundError(err)) {
      return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
    }
    getLogger('document').error({ err: err as Error }, failure.logged)
    return c.json({ title: failure.answered } satisfies ApiErrorBody, 500)
  }
}

const listHandler =
  (deps: ServerDeps): Handler =>
  (c) =>
    answering(
      deps,
      c,
      { answered: 'Failed to list the trash.', logged: 'trash list failed unexpectedly' },
      async (workspaceId, trash) => {
        // The trash lives in the workspace record; an unknown workspace has no
        // record to open, which the seam refuses — translated to 404 by
        // `answering`. A known-but-empty trash is an empty list, never an error.
        const entries = await trash.list({ workspaceId })
        const response: ListTrashResponse = {
          entries: entries.map((entry) => ({
            documentId: entry.documentId,
            path: entry.path,
            deletedAt: entry.deletedAt,
          })),
        }
        return c.json(response)
      },
    )

const restoreHandler =
  (deps: ServerDeps): Handler =>
  (c) =>
    answering(
      deps,
      c,
      {
        answered: 'Failed to restore from the trash.',
        logged: 'trash restore failed unexpectedly',
      },
      async (workspaceId, trash) => {
        const documentId = c.req.param('documentId') ?? ''
        const restored = await trash.restore({ workspaceId, documentId })
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
      },
    )

const purgeHandler =
  (deps: ServerDeps): Handler =>
  (c) =>
    answering(
      deps,
      c,
      { answered: 'Failed to delete from the trash.', logged: 'trash purge failed unexpectedly' },
      async (workspaceId, trash) => {
        const documentId = c.req.param('documentId') ?? ''
        // Only an entry that IS in the trash is reachable: a live document with
        // the same id is not, so this cannot be turned into a way to destroy
        // something nobody deleted.
        if (!(await trash.purge({ workspaceId, documentId }))) {
          return c.json({ title: `Nothing in the trash for "${documentId}"` }, 404)
        }
        const response: PurgeTrashEntryResponse = { purged: { documentId } }
        return c.json(response)
      },
    )

export function createTrashRouter(options: TrashRouterOptions): Hono {
  const app = new Hono()
  const deps = options.serverDeps

  app.get('/api/workspaces/:workspaceId/trash', listHandler(deps))
  app.post('/api/workspaces/:workspaceId/trash/:documentId/restore', restoreHandler(deps))
  app.delete('/api/workspaces/:workspaceId/trash/:documentId', purgeHandler(deps))

  return app
}
