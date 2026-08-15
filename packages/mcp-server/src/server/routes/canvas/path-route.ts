import type { Context, Hono, MiddlewareHandler, Next } from 'hono'
import {
  canvasPathForAction,
  canvasPathForFile,
  parseCanvasApiPath,
} from '../../../shared/api-contracts/canvas-url.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'

export const CANVAS_WILDCARD = '/api/w/:workspaceId/canvas/*'

type CanvasHandler = (c: Context, workspaceId: string, path: string) => Promise<Response> | Response
type CanvasFileHandler = (
  c: Context,
  workspaceId: string,
  path: string,
  fileId: string,
) => Promise<Response> | Response

function validated(c: Context, workspaceId: string, path: string): Response | null {
  try {
    validateWorkspaceId(workspaceId)
    validateSlug(path)
  } catch (err) {
    const body = validationErrorBody(err)
    if (body) return c.json(body, 400)
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
