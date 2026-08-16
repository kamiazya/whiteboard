import type { Context, Hono, MiddlewareHandler, Next } from 'hono'
import {
  canvasPathForAction,
  canvasPathForFile,
  parseCanvasApiPath,
} from '../../../shared/api-contracts/canvas-url.js'
import { validateDocumentPath, validateWorkspaceId, validationErrorBody } from '../../validators.js'

export const CANVAS_WILDCARD = '/api/w/:workspaceId/canvas/*'

type CanvasHandler = (c: Context, workspaceId: string, path: string) => Promise<Response> | Response
type CanvasFileHandler = (
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
        ? c.json({ title: body.message }, 400)
        : c.json(body, 400)
    }
    throw err
  }
  return null
}

/**
 * Registers `<method> /api/w/:workspaceId/canvas/<document path>/<action>`.
 *
 * Every action shares one wildcard route and dispatches on the parsed tail —
 * a non-matching action falls through to `next()` so sibling registrations
 * (and the composed routers after this one) still get their turn. See
 * parseCanvasApiPath for why this is a hand parse instead of a `{.+}` param.
 */
export function onCanvasAction(
  app: Hono,
  method: 'get' | 'post' | 'put',
  action: string,
  handler: CanvasHandler,
  ...middleware: MiddlewareHandler[]
): void {
  const dispatch = async (c: Context, next: Next) => {
    const parsed = parseCanvasApiPath(c.req.path)
    const path = parsed === null ? null : canvasPathForAction(parsed.tail, action)
    if (parsed === null || path === null) return next()
    return validated(c, parsed.workspaceId, path) ?? handler(c, parsed.workspaceId, path)
  }
  app[method](CANVAS_WILDCARD, ...(middleware as []), dispatch)
}

/** Same, for the `<document path>/file/<fileId>` tail. */
export function onCanvasFile(
  app: Hono,
  method: 'get' | 'put',
  handler: CanvasFileHandler,
  ...middleware: MiddlewareHandler[]
): void {
  const dispatch = async (c: Context, next: Next) => {
    const parsed = parseCanvasApiPath(c.req.path)
    const file = parsed === null ? null : canvasPathForFile(parsed.tail)
    if (parsed === null || file === null) return next()
    return (
      validated(c, parsed.workspaceId, file.path) ??
      handler(c, parsed.workspaceId, file.path, file.fileId)
    )
  }
  app[method](CANVAS_WILDCARD, ...(middleware as []), dispatch)
}

export const CANVASES_WILDCARD = '/api/workspaces/:workspaceId/canvases/*'

const CANVASES_PREFIX = /^\/api\/workspaces\/([^/]+)\/canvases\/(.+)$/

type CanvasesHandler = (
  c: Context,
  workspaceId: string,
  path: string,
  params: Record<string, string>,
) => Promise<Response> | Response

/**
 * The `/api/workspaces/:workspaceId/canvases/<document path>/<suffix...>`
 * family — same wildcard dispatch as onCanvasAction, with a multi-segment
 * suffix pattern matched FROM THE END (`':x'` entries capture). The suffix
 * anchoring is what keeps a nested path unambiguous, exactly as with the
 * single-action routes: `a/versions/versions` is the versions listing of the
 * document `a/versions`. An empty pattern (delete) takes the whole tail as
 * the path.
 */
export function onCanvasesRoute(
  app: Hono,
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  suffixPattern: string[],
  handler: CanvasesHandler,
  options: { badRequest?: 'legacy' | 'problem-details' } = {},
  ...middleware: MiddlewareHandler[]
): void {
  const dispatch = async (c: Context, next: Next) => {
    const match = c.req.path.match(CANVASES_PREFIX)
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
    return (
      validated(c, workspaceId, path, options.badRequest) ?? handler(c, workspaceId, path, params)
    )
  }
  app[method](CANVASES_WILDCARD, ...(middleware as []), dispatch)
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
