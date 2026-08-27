import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  isWorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import {
  type ServerDeps,
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
} from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import type { z } from 'zod'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import {
  type CreateDocumentResponse,
  createDocumentRequestSchema,
  type DeleteDocumentResponse,
  type ListDocumentsResponse,
  type ListWorkspacesResponse,
  type RenameDocumentPathResponse,
  renameDocumentPathRequestSchema,
} from '../../../shared/api-contracts/document.js'
import type { ApiErrorBody } from '../../../shared/api-contracts/errors.js'
import { getLogger } from '../../log.js'
import { validateDocumentPath, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { handleCorruptStoredData } from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

// Names the specific field createDocumentRequestSchema rejected, instead of a
// single message covering the whole request — a valid path with an invalid
// kind must not be told "path is required", which names the wrong field and
// gives the caller no path to recovery.
function createDocumentRequestErrorTitle(error: z.ZodError): string {
  const issue = error.issues[0]
  const field = issue?.path[0]
  if (field === 'kind') return 'kind must be "spatial" or "markdown"'
  if (field === 'path') return 'path is required'
  return issue?.message ?? 'invalid request body'
}

export interface WorkspacesRouterOptions {
  /** The operations this router adapts onto. Omitted by callers that have
   *  not been given a container — see `getDefaultServerDeps`, which is the
   *  same wiring production passes in, not a stand-in for it. */
  serverDeps?: ServerDeps
}

// GET /api/workspaces
// GET /api/workspaces/:workspaceId/documents
// POST /api/workspaces/:workspaceId/documents  body: { path: string }
export function createWorkspacesRouter(options: WorkspacesRouterOptions = {}) {
  const app = new Hono()

  app.get('/api/workspaces', async (c) => {
    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      // Straight to the PORT, for the same reason the rename is (ADR-0018):
      // listing workspaces is the port call and nothing else, so a use case
      // here would forward no arguments and add a name.
      const workspaces = await deps.documentIndex.listWorkspaces()
      const response: ListWorkspacesResponse = {
        workspaces: workspaces.map(({ workspaceId }) => ({ workspaceId })),
      }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.get('/api/workspaces/:workspaceId/documents', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      const { documents } = await wbDocumentList(deps, { workspaceId })
      // The port names a document by the id the index assigned and calls what
      // a human reads its `name`; this surface has always said `id` and
      // `displayName`. Renaming either would be a published break for a
      // translation an adapter is there to do.
      const response: ListDocumentsResponse = {
        documents: documents.map((entry) => ({
          path: entry.path,
          id: entry.documentId,
          ...(entry.name === undefined ? {} : { displayName: entry.name }),
          ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
          ...(entry.shadowed === undefined ? {} : { shadowed: entry.shadowed }),
        })),
      }
      return c.json(response)
    } catch (err) {
      // "Empty" and "never registered" are different answers, and conflating
      // them is what let a stale pairing render as an empty workspace with a
      // Create button. The operation refuses an unknown workspace rather than
      // answering with an empty list, which is what makes this translation
      // possible without a second existence query.
      //
      // So the two cases a client must tell apart are: a workspace that
      // exists and holds nothing answers 200 with an empty array, and only an
      // ABSENT one answers 404. A 404 here therefore means gone, never empty.
      if (isWorkspaceNotFoundError(err)) {
        return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
      }
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // Save a new empty LoroDoc under path. Return 409 for conflicts and 400 for invalid paths.
  // On success, return { path } for client-side navigation.
  app.post('/api/workspaces/:workspaceId/documents', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json({ title: body.message } satisfies ApiErrorBody, 400)
      throw err
    }
    const raw = await c.req.json().catch(() => null)
    if (raw === null) {
      return c.json({ title: 'JSON body required' } satisfies ApiErrorBody, 400)
    }
    const parsed = createDocumentRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        { title: createDocumentRequestErrorTitle(parsed.error) } satisfies ApiErrorBody,
        400,
      )
    }
    const path = parsed.data.path
    try {
      validateDocumentPath(path)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json({ title: body.message } satisfies ApiErrorBody, 400)
      throw err
    }
    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      await wbDocumentCreate(deps, {
        workspaceId,
        path,
        kind: parsed.data.kind,
        // `saveDocument` used to upsert the workspace row on the way past, so
        // posting into a workspace that does not exist yet has always worked
        // on this surface. The operation makes that an explicit flag rather
        // than a side effect, and this preserves the behaviour.
        createWorkspace: true,
        // Passed through as given. A blank name meaning "no name" is the
        // OPERATION's rule now, not a second copy of it here — two places
        // normalising the same field is two places that can stop agreeing.
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      })
      const response: CreateDocumentResponse = { path }
      return c.json(response)
    } catch (err) {
      if (err instanceof DocumentPathTakenError) {
        return c.json({ title: `Canvas "${path}" already exists` }, 409)
      }
      getLogger('document').error({ err: err as Error }, 'wb_document_create failed unexpectedly')
      return c.json({ title: 'Failed to create canvas.' } satisfies ApiErrorBody, 500)
    }
  })

  // Delete a canvas: row (branches/versions cascade via FK), .loro blob,
  // version thumbnails, and doc-cache entry. Idempotent-shaped 404 for a
  // missing canvas rather than a throw.
  //
  // An ADAPTER over `wb_document_delete` (ADR-0018), not a second
  // implementation of it. The two were separate sequences performing the
  // same delete, and only one of them cleaned up; sharing the pieces closed
  // that gap once, and sharing the operation is what stops the next piece
  // from drifting. All this translates is the ADDRESS — this surface names a
  // document by path, the operation by the id the index assigned — and the
  // absent case, which is a 404 here and a throw there.
  onDocumentsRoute(
    app,
    'delete',
    [],
    async (c, workspaceId, path) => {
      try {
        const deps = options.serverDeps ?? (await getDefaultServerDeps())
        const entry = await deps.documentIndex.resolveDocument({ workspaceId, path })
        if (entry === null) {
          return c.json({ title: `Canvas "${path}" not found` }, 404)
        }
        await wbDocumentDelete(deps, { workspaceId, documentId: entry.documentId })
        const response: DeleteDocumentResponse = { ok: true }
        return c.json(response)
      } catch (err) {
        // The tree index refuses an unknown workspace with a throw where the
        // retired SQL index answered null; this surface's spelling of both
        // is the same 404.
        if (isWorkspaceNotFoundError(err)) {
          return c.json({ title: `Canvas "${path}" not found` }, 404)
        }
        // A refusal, not a failure: the caller has to name what it destroys.
        if (err instanceof DocumentHasDescendantsError) {
          return c.json({ title: err.message } satisfies ApiErrorBody, 409)
        }
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        getLogger('document').error({ err: err as Error }, 'wb_document_delete failed unexpectedly')
        return c.json({ title: 'Failed to delete canvas.' } satisfies ApiErrorBody, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  // Rename a canvas's path in place: same documentId, same branches/versions/blob,
  // just a new path column. Old URLs carrying the old path 404 by design — no
  // redirect, no alias history (0.0.x).
  //
  // An ADAPTER over `documentIndex.moveDocument` (ADR-0018). Straight to the
  // port rather than through a `wb_document_*` operation, because there is no
  // operation to write: a move is the port call and nothing else, so a use
  // case here would forward one argument set and add a name. The delete and
  // create differ — each composes several steps that a second surface would
  // otherwise repeat.
  //
  // The web app's move/rename UI reaches exactly this route
  // (`WorkspaceFilesPanel` -> `daemon-files-source` -> `PUT …/documents/:path/path`),
  // so a stale comment here claiming nothing called it has been removed.
  onDocumentsRoute(
    app,
    'put',
    ['path'],
    async (c, workspaceId, path) => {
      const raw = await c.req.json().catch(() => null)
      if (raw === null) {
        return c.json({ title: 'JSON body required' } satisfies ApiErrorBody, 400)
      }
      const parsed = renameDocumentPathRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ title: 'path is required' } satisfies ApiErrorBody, 400)
      }
      const newPath = parsed.data.path
      try {
        validateDocumentPath(newPath)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json({ title: body.message } satisfies ApiErrorBody, 400)
        throw err
      }
      try {
        const deps = options.serverDeps ?? (await getDefaultServerDeps())
        await deps.documentIndex.moveDocument({ workspaceId, from: path, to: newPath })
        const response: RenameDocumentPathResponse = { path: newPath }
        return c.json(response)
      } catch (err) {
        // Absent is a 404 here and a throw there — the same translation the
        // delete makes, in the opposite direction. An unknown WORKSPACE is
        // the same answer: nothing at that address.
        if (isWorkspaceNotFoundError(err)) {
          return c.json({ title: `Canvas "${path}" not found` }, 404)
        }
        if (err instanceof DocumentNotFoundError) {
          return c.json({ title: `Canvas "${path}" not found` }, 404)
        }
        // A move into the document's own subtree is an unusable target, not
        // a race with another document — 400, not 409.
        if (err instanceof DocumentMoveIntoSelfError) {
          return c.json({ title: err.message } satisfies ApiErrorBody, 400)
        }
        // Forward the raised message rather than rebuilding one from
        // newPath: a subtree move collides on a PRODUCED path, so the path
        // the caller asked for is often free and naming it sends them to
        // retry the one thing that was never the problem.
        if (err instanceof DocumentPathTakenError) {
          return c.json({ title: err.message } satisfies ApiErrorBody, 409)
        }
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        getLogger('document').error({ err: err as Error }, 'moveDocument failed unexpectedly')
        return c.json({ title: 'Failed to rename canvas.' } satisfies ApiErrorBody, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  return app
}
