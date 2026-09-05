import {
  documentPathForAction,
  documentPathForFile,
  parseDocumentApiPath,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import type { ApiErrorBody } from '@kamiazya/whiteboard-daemon-client/api-contracts/errors'
import type { Context, Hono, MiddlewareHandler, Next } from 'hono'
import { validateDocumentPath, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'

export const DOCUMENT_WILDCARD = '/api/w/:workspaceId/document/*'

type DocumentHandler = (
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

function validated(
  c: Context,
  workspaceId: string,
  path: string,
  badRequest: 'legacy' | 'problem-details' = 'legacy',
): Response | null {
  try {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
  } catch (err) {
    const body = validationErrorBody(err)
    // Two 400 shapes coexist on this surface: the older { error, message }
    // and Problem Details { title } (delete/rename, pinned by tests). The
    // caller says which its route speaks.
    if (body) {
      return badRequest === 'problem-details'
        ? c.json({ title: body.message } satisfies ApiErrorBody, 400)
        : c.json(body, 400)
    }
    throw err
  }
  return null
}

/**
 * Registers `<method> /api/w/:workspaceId/document/<document path>/<action>`.
 *
 * Every action shares one wildcard route and dispatches on the parsed tail —
 * a non-matching action falls through to `next()` so sibling registrations
 * (and the composed routers after this one) still get their turn. See
 * parseDocumentApiPath for why this is a hand parse instead of a `{.+}` param.
 */
export function onDocumentAction(
  app: Hono,
  method: 'get' | 'post' | 'put',
  action: string,
  handler: DocumentHandler,
  ...middleware: MiddlewareHandler[]
): void {
  const dispatch = async (c: Context, next: Next) => {
    const parsed = parseDocumentApiPath(c.req.path)
    const path = parsed === null ? null : documentPathForAction(parsed.tail, action)
    if (parsed === null || path === null) return next()
    // Validated on the handle AS WRITTEN, so a malformed one keeps its 400;
    // resolved afterwards, so the handler only ever sees a canonical id.
    const invalid = validated(c, parsed.workspaceId, path)
    if (invalid) return invalid
    return handler(c, await workspaceIdFromHandle(c, parsed.workspaceId), path)
  }
  app[method](DOCUMENT_WILDCARD, ...(middleware as []), dispatch)
}

/** Same, for the `<document path>/file/<fileId>` tail. */
export function onDocumentFile(
  app: Hono,
  method: 'get' | 'put',
  handler: DocumentFileHandler,
  ...middleware: MiddlewareHandler[]
): void {
  const dispatch = async (c: Context, next: Next) => {
    const parsed = parseDocumentApiPath(c.req.path)
    const file = parsed === null ? null : documentPathForFile(parsed.tail)
    if (parsed === null || file === null) return next()
    const invalid = validated(c, parsed.workspaceId, file.path)
    if (invalid) return invalid
    return handler(c, await workspaceIdFromHandle(c, parsed.workspaceId), file.path, file.fileId)
  }
  app[method](DOCUMENT_WILDCARD, ...(middleware as []), dispatch)
}

export const DOCUMENTS_WILDCARD = '/api/workspaces/:workspaceId/documents/*'

const DOCUMENTS_PREFIX = /^\/api\/workspaces\/([^/]+)\/documents\/(.+)$/

type DocumentsHandler = (
  c: Context,
  workspaceId: string,
  path: string,
  params: Record<string, string>,
) => Promise<Response> | Response

/**
 * The `/api/workspaces/:workspaceId/documents/<document path>/<suffix...>`
 * family — same wildcard dispatch as onDocumentAction, with a multi-segment
 * suffix pattern matched FROM THE END (`':x'` entries capture). The suffix
 * anchoring is what keeps a nested path unambiguous, exactly as with the
 * single-action routes: `a/versions/versions` is the versions listing of the
 * document `a/versions`. An empty pattern (delete) takes the whole tail as
 * the path.
 */
export function onDocumentsRoute(
  app: Hono,
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  suffixPattern: string[],
  handler: DocumentsHandler,
  options: { badRequest?: 'legacy' | 'problem-details' } = {},
  ...middleware: MiddlewareHandler[]
): void {
  const dispatch = async (c: Context, next: Next) => {
    const match = c.req.path.match(DOCUMENTS_PREFIX)
    if (match === null) return next()
    const workspaceId = decodePathSegment(match[1] ?? '')
    const rawTail = (match[2] ?? '').replace(/\/$/, '').split('/')
    const tail = rawTail.map(decodePathSegment)
    if (workspaceId === null || tail.some((segment) => segment === null || segment === '')) {
      return next()
    }
    if (tail.length < suffixPattern.length + 1) return next()
    const params: Record<string, string> = {}
    const suffixStart = tail.length - suffixPattern.length
    for (const [i, expected] of suffixPattern.entries()) {
      const actual = tail[suffixStart + i] as string
      if (expected.startsWith(':')) params[expected.slice(1)] = actual
      else if (actual !== expected) return next()
    }
    const path = (tail.slice(0, suffixStart) as string[]).join('/')
    const invalid = validated(c, workspaceId, path, options.badRequest)
    if (invalid) return invalid
    return handler(c, await workspaceIdFromHandle(c, workspaceId), path, params)
  }
  app[method](DOCUMENTS_WILDCARD, ...(middleware as []), dispatch)
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
