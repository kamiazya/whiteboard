import type { DocumentApiAction } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { documentIdSchema } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { errorBody, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { Context, Hono, HonoRequest, MiddlewareHandler, Next } from 'hono'
import {
  parseWorkspaceHandle,
  refuseMalformedHandle,
  workspaceIdFromHandle,
} from '../../workspace-handle.js'

/**
 * `middleware`, run only for a request `owns`: a route's own middleware must
 * not run for a sibling pattern's request that the router tries first, so an
 * update's body ceiling and content slot are never taken by an export.
 */
function scopedTo(
  owns: (c: Context) => boolean,
  middleware: readonly MiddlewareHandler[],
): MiddlewareHandler[] {
  return middleware.map((each) => (c, next) => (owns(c) ? each(c, next) : next()))
}

export type DocumentHandler = (
  c: Context,
  workspaceId: string,
  path: string,
) => Promise<Response> | Response
type DocumentFileHandler = (
  c: Context,
  workspaceId: string,
  path: string,
  fileId: string,
) => Promise<Response> | Response

/**
 * Registers `<method> /api/workspaces/:workspaceId/documents/:documentId/<action>`,
 * typed by the closed action set the client builds from.
 */
export function onDocumentAction(
  app: Hono,
  method: 'get' | 'post' | 'put',
  action: DocumentApiAction,
  handler: DocumentHandler,
  ...middleware: MiddlewareHandler[]
): void {
  onDocumentRoute(app, method, `/${action}`, handler, ...middleware)
}

/** Same, for the document's `/files/:fileId`. */
export function onDocumentFile(
  app: Hono,
  method: 'get' | 'put',
  handler: DocumentFileHandler,
  ...middleware: MiddlewareHandler[]
): void {
  onDocumentRoute(
    app,
    method,
    '/files/:fileId',
    (c, workspaceId, path, params) => handler(c, workspaceId, path, params.fileId as string),
    ...middleware,
  )
}

type DocumentsHandler = (
  c: Context,
  workspaceId: string,
  path: string,
  params: Record<string, string>,
) => Promise<Response> | Response

const resolvedDocuments = new WeakMap<HonoRequest, DocumentEntry | null>()

/**
 * What the document-id address resolved to for this request: the entry, `null`
 * for an id naming nothing live (unknown, another workspace's, or trashed), or
 * `undefined` when the request carries no id address or was not resolved.
 */
export function resolvedDocumentOf(c: Context): DocumentEntry | null | undefined {
  return resolvedDocuments.get(c.req)
}

/**
 * Resolves `:documentId` to its placement ONCE per request, ahead of every
 * route registered through `onDocumentRoute`, so a route's own middleware and
 * its handler read one answer instead of asking the index twice. Keyed on the
 * HonoRequest for the reason `workspaceIdFromHandle`'s memo is.
 *
 * A middleware rather than an option of each router: the index is reached only
 * through the port on `ServerDeps` (ADR-0018), and most routers hold no deps.
 * A malformed workspace handle or a non-ULID segment passes through; the route
 * words its own refusal.
 */
export function resolveDocumentAddress(
  deps: Pick<ServerDeps, 'documentIndex'>,
  /** The answer for a record the index cannot read; a failure it does not own is rethrown. */
  refusing: (err: unknown, c: Context) => Response | null = () => null,
): MiddlewareHandler {
  return async (c, next) => {
    const documentId = c.req.param('documentId') ?? ''
    const handle = c.req.param('workspaceId') ?? ''
    if (!documentIdSchema.safeParse(documentId).success) return next()
    if (refuseMalformedHandle(c, handle) !== null) return next()
    const workspaceId = await workspaceIdFromHandle(c, handle)
    try {
      resolvedDocuments.set(
        c.req,
        await deps.documentIndex.resolveDocumentById({ workspaceId, documentId }),
      )
    } catch (err) {
      // The record is read here, ahead of the handler, so a failure the
      // composition knows how to word is answered here too.
      const refusal = refusing(err, c)
      if (refusal) return refusal
      throw err
    }
    return next()
  }
}

const isDocumentId = (c: Context) => documentIdSchema.safeParse(c.req.param('documentId')).success

/**
 * Registers `<method> /api/workspaces/:workspaceId/documents/:documentId<suffix>`
 * and hands the handler the placement the id resolves to.
 *
 * A `:documentId` that is not a canonical ULID is not this route's: it falls
 * through, and the app answers `not_found`. The path family that once shared
 * this grammar (`…/documents/<document path>/<suffix>`) is retired, so a
 * multi-segment address under `/documents/` names nothing.
 *
 * An id the index does not hold live — unknown, another workspace's, or in the
 * trash — is a 404 here, which is also what keeps a stale tab from writing
 * under a deleted document: nothing it addresses by id resolves.
 */
export function onDocumentRoute(
  app: Hono,
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  suffix: '' | `/${string}`,
  handler: DocumentsHandler,
  ...middleware: MiddlewareHandler[]
): void {
  const dispatch = async (c: Context, next: Next) => {
    const documentId = c.req.param('documentId') ?? ''
    if (!documentIdSchema.safeParse(documentId).success) return next()
    const parsed = await parseWorkspaceHandle(c, c.req.param('workspaceId') ?? '')
    if ('refusal' in parsed) return parsed.refusal
    const entry = resolvedDocumentOf(c)
    if (entry === undefined) {
      throw new Error('document id route mounted without resolveDocumentAddress')
    }
    if (entry === null) {
      return c.json(errorBody('not_found', `Document "${documentId}" not found`), 404)
    }
    return handler(c, parsed.workspaceId, entry.path, c.req.param())
  }
  const pattern = `/api/workspaces/:workspaceId/documents/:documentId${suffix}`
  app[method](pattern, ...(scopedTo(isDocumentId, middleware) as []), dispatch)
}
