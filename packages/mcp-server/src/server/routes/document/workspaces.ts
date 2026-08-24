import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentPathTakenError,
} from '@kamiazya/whiteboard-ports'
import {
  type ServerDeps,
  wbDocumentCreate,
  wbDocumentDelete,
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
import {
  ConflictError,
  listDocuments,
  listWorkspaces,
  renameDocumentPath,
  workspaceExists,
} from '../../store/document-store.js'
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
      const workspaces = await listWorkspaces()
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
      // "Empty" and "never registered" are different answers, and conflating
      // them is what let a stale pairing render as an empty workspace with a
      // Create button. Same problem-details shape as live-doc's snapshot 404.
      if (!(await workspaceExists(workspaceId))) {
        return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
      }
      const documents = await listDocuments(workspaceId)
      const response: ListDocumentsResponse = { documents }
      return c.json(response)
    } catch (err) {
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
      // A blank name means "no name" — the rule `setDocumentDisplayName` used
      // to hold, kept here because the operation does not hold it. Measured:
      // passing `'   '` through stores an empty name rather than rejecting
      // it, which `DocumentEntry.name` declares as `z.string().min(1)` and so
      // is a value the port says cannot exist. Trim and omit.
      const name = parsed.data.name?.trim()
      await wbDocumentCreate(deps, {
        workspaceId,
        path,
        kind: parsed.data.kind,
        // `saveDocument` used to upsert the workspace row on the way past, so
        // posting into a workspace that does not exist yet has always worked
        // on this surface. The operation makes that an explicit flag rather
        // than a side effect, and this preserves the behaviour.
        createWorkspace: true,
        ...(name === undefined || name === '' ? {} : { name }),
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
  // Server-side foundation only: no MCP tool, CLI command, or apps/web
  // affordance calls this route yet. The apps/web path-edit UI is a planned
  // follow-up, not dead code.
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
        const result = await renameDocumentPath(workspaceId, path, newPath)
        if (!result) {
          return c.json({ title: `Canvas "${path}" not found` }, 404)
        }
        const response: RenameDocumentPathResponse = { path: newPath }
        return c.json(response)
      } catch (err) {
        // A move into the document's own subtree is an unusable target, not
        // a race with another document — 400, not 409.
        if (err instanceof DocumentMoveIntoSelfError) {
          return c.json({ title: err.message } satisfies ApiErrorBody, 400)
        }
        // Forward the store's message rather than rebuilding one from
        // newPath: a subtree move collides on a PRODUCED path, so the path
        // the caller asked for is often free and naming it sends them to
        // retry the one thing that was never the problem.
        if (err instanceof ConflictError) {
          return c.json({ title: err.message } satisfies ApiErrorBody, 409)
        }
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        getLogger('document').error({ err: err as Error }, 'renameDocumentPath failed unexpectedly')
        return c.json({ title: 'Failed to rename canvas.' } satisfies ApiErrorBody, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  return app
}
