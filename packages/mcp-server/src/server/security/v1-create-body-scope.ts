import { errorBody } from '@kamiazya/whiteboard-server-core'
import type { Context, MiddlewareHandler } from 'hono'
import { type AuthScope, hasRequiredScopes } from './auth-strategy.js'
import { createBodyScopes } from './route-scope-registry.js'

const V1_DOCUMENT_CREATE = /^\/api\/v1\/workspaces\/[^/]+\/documents$/

/**
 * The registry scopes `POST /api/v1/…/documents` by its path, at the
 * `workspace:write` that places a document, before the body says whether the
 * create also writes content. server-core serves the route and knows no
 * caller, so the daemon reads the body here — Hono caches it, so the route
 * reads the same one — and holds a create carrying markdown to
 * `createBodyScopes`. A body that is not JSON passes, for the route to refuse
 * in its own words.
 *
 * Either mode's auth middleware records a grant before `/api/v1`, so a request
 * arriving with none got here by some path that skipped it, and is refused
 * whatever its body asks for.
 */
export function holdV1CreateBodyToScope(
  callerScopes: (c: Context) => readonly AuthScope[] | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'POST' || !V1_DOCUMENT_CREATE.test(c.req.path)) return next()
    const granted = callerScopes(c)
    if (granted === undefined) return refuse(c)
    let asked: unknown
    try {
      asked = await c.req.json()
    } catch {
      return next()
    }
    const body =
      asked !== null && typeof asked === 'object' ? (asked as { markdown?: unknown }) : {}
    if (hasRequiredScopes(granted, createBodyScopes(body))) return next()
    return refuse(c)
  }
}

function refuse(c: Context): Response {
  return c.json(
    errorBody(
      'insufficient_scope',
      "This credential's scopes do not reach writing a document's content.",
    ),
    403,
  )
}
