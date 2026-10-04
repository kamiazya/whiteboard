/**
 * The trash surface: list what deletes evacuated, restore one entry, or
 * destroy one for good.
 *
 * An ADAPTER over the index's `DocumentTrash` capability (ADR-0018): the
 * evacuate/restore mechanics live in workspace-index, and all this
 * translates is the ADDRESS (workspaceId + documentId in the URL) and the
 * absent cases — unknown workspace and unknown entry are both 404 here, a
 * composition with no trash capability is 501.
 */

import type {
  ListTrashResponse,
  PurgeTrashEntryResponse,
  RestoreTrashResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { workspaceNotFoundRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  type DocumentTrash,
  hasDocumentTrash,
  isDatabaseBusy,
  isWorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
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
// refused outside the try below, the unknown workspace answered 404, a busy
// database left to the app's 503 with Retry-After, anything else logged and
// answered 500.
async function answering(
  deps: ServerDeps,
  c: Context,
  failure: { readonly answered: string; readonly logged: string },
  body: (workspaceId: string, trash: DocumentTrash) => Promise<Response>,
): Promise<Response> {
  // A malformed address is the caller's error, not this server's — kept
  // outside the try below so it cannot fall through to the 500 arm.
  const address = await parseWorkspaceHandle(c, c.req.param('workspaceId') ?? '')
  if ('refusal' in address) return address.refusal
  const { workspaceId } = address
  try {
    // Structural rather than `instanceof`: the binding is a composition
    // root's choice, and vitest's module-graph split makes `instanceof` lie
    // across realms (see ports' `isWorkspaceNotFoundError`).
    const { documentIndex } = deps
    if (!hasDocumentTrash(documentIndex)) return c.json(NO_TRASH, 501)
    return await body(workspaceId, documentIndex)
  } catch (err) {
    if (isWorkspaceNotFoundError(err)) {
      return c.json(workspaceNotFoundRefusal(workspaceId), 404)
    }
    if (isDatabaseBusy(err)) throw err
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
        const entries = await trash.listTrash({ workspaceId })
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
        const restored = await trash.restoreDocument({ workspaceId, documentId })
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
        if (!(await trash.purgeTrashEntry({ workspaceId, documentId }))) {
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
