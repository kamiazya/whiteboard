import {
  type DocumentApiAction,
  decodeSegment,
  documentPathForAction,
  documentPathForFile,
  parseDocumentApiPath,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import type { ApiErrorBody } from '@kamiazya/whiteboard-server-core'
import type { Context, Hono, MiddlewareHandler, Next } from 'hono'
import { validateDocumentPath, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'

export const DOCUMENT_WILDCARD = '/api/w/:workspaceId/document/*'

/**
 * `middleware`, run only for a request `owns` — every action shares one
 * wildcard, so a middleware registered beside it would otherwise run for
 * every sibling's request too, and an update's body ceiling and content slot
 * would be taken by an export.
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

// Not `parseWorkspaceHandle`: the handle and the document path are validated in
// one try, with the 400 shape chosen per route, and the handle is resolved
// only after both pass.
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
  action: DocumentApiAction,
  handler: DocumentHandler,
  ...middleware: MiddlewareHandler[]
): void {
  const pathOf = (c: Context) => {
    const parsed = parseDocumentApiPath(c.req.path)
    const path = parsed === null ? null : documentPathForAction(parsed.tail, action)
    return parsed === null || path === null ? null : { parsed, path }
  }
  const dispatch = async (c: Context, next: Next) => {
    const matched = pathOf(c)
    if (matched === null) return next()
    const { parsed, path } = matched
    // Validated on the handle AS WRITTEN, so a malformed one keeps its 400;
    // resolved afterwards, so the handler only ever sees a canonical id.
    const invalid = validated(c, parsed.workspaceId, path)
    if (invalid) return invalid
    return handler(c, await workspaceIdFromHandle(c, parsed.workspaceId), path)
  }
  const scoped = scopedTo((c) => pathOf(c) !== null, middleware)
  app[method](DOCUMENT_WILDCARD, ...(scoped as []), dispatch)
}

/** Same, for the `<document path>/file/<fileId>` tail. */
export function onDocumentFile(
  app: Hono,
  method: 'get' | 'put',
  handler: DocumentFileHandler,
  ...middleware: MiddlewareHandler[]
): void {
  const fileOf = (c: Context) => {
    const parsed = parseDocumentApiPath(c.req.path)
    const file = parsed === null ? null : documentPathForFile(parsed.tail)
    return parsed === null || file === null ? null : { parsed, file }
  }
  const dispatch = async (c: Context, next: Next) => {
    const matched = fileOf(c)
    if (matched === null) return next()
    const { parsed, file } = matched
    const invalid = validated(c, parsed.workspaceId, file.path)
    if (invalid) return invalid
    return handler(c, await workspaceIdFromHandle(c, parsed.workspaceId), file.path, file.fileId)
  }
  const scoped = scopedTo((c) => fileOf(c) !== null, middleware)
  app[method](DOCUMENT_WILDCARD, ...(scoped as []), dispatch)
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
 * The whole parse behind `onDocumentsRoute`, as a pure function of the URL.
 *
 * `null` means "this is not my route" — every caller answers it with
 * `next()`, so a suffix that does not match falls through to the sibling
 * registrations rather than refusing. The suffix is matched FROM THE END,
 * which is what keeps a nested document path unambiguous: `a/versions/versions`
 * is the versions listing of the document `a/versions`, not a listing of `a`.
 */
export function matchDocumentsTail(
  pathname: string,
  suffixPattern: string[],
): { workspaceId: string; path: string; params: Record<string, string> } | null {
  const match = pathname.match(DOCUMENTS_PREFIX)
  if (match === null) return null
  const workspaceId = decodeSegment(match[1] ?? '')
  const rawTail = (match[2] ?? '').replace(/\/$/, '').split('/')
  const tail = rawTail.map((segment) => decodeSegment(segment))
  if (workspaceId === null || tail.some((segment) => segment === null || segment === '')) {
    return null
  }
  if (tail.length < suffixPattern.length + 1) return null

  const params: Record<string, string> = {}
  const suffixStart = tail.length - suffixPattern.length
  for (const [i, expected] of suffixPattern.entries()) {
    const actual = tail[suffixStart + i] as string
    if (expected.startsWith(':')) params[expected.slice(1)] = actual
    else if (actual !== expected) return null
  }
  return { workspaceId, path: (tail.slice(0, suffixStart) as string[]).join('/'), params }
}

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
    const matched = matchDocumentsTail(c.req.path, suffixPattern)
    if (matched === null) return next()
    const { workspaceId, path, params } = matched
    const invalid = validated(c, workspaceId, path, options.badRequest)
    if (invalid) return invalid
    return handler(c, await workspaceIdFromHandle(c, workspaceId), path, params)
  }
  const owns = (c: Context) => matchDocumentsTail(c.req.path, suffixPattern) !== null
  app[method](DOCUMENTS_WILDCARD, ...(scopedTo(owns, middleware) as []), dispatch)
}
