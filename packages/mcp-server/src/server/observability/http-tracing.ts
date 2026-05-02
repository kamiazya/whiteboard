import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions'
import type { MiddlewareHandler } from 'hono'
import { extractContextFromHeaders, getTracer } from './tracing.js'

// Hono middleware that opens a SERVER-kind span per request, propagates
// W3C trace context, and records HTTP semantic-convention attributes.
//
// Span name + http.route follow the *matched* Hono route pattern (e.g.
// "/api/workspaces/:wid/canvases/:slug/compact"), not the wildcard the
// middleware itself is registered under. We learn the matched route by
// inspecting `c.req.matchedRoutes` AFTER next() — at middleware-entry the
// router has not yet matched a downstream handler, so `c.req.routePath`
// reflects only the wildcard. The attribute exists primarily so dashboards
// can group by low-cardinality route, so getting that right matters more
// than naming the span at start time.

function resolveMatchedRoute(c: Parameters<MiddlewareHandler>[0]): string {
  // Hono populates `matchedRoutes` with every middleware + handler the
  // request hit, in order. Skip the wildcard middlewares (those whose
  // path is "/*" or "/api/*" etc.) and return the first concrete one.
  // Falls back to the path itself for unrouted requests.
  type MatchedRoute = { path?: string; handler?: unknown; method?: string }
  const matched = (c.req as unknown as { matchedRoutes?: MatchedRoute[] }).matchedRoutes
  if (Array.isArray(matched)) {
    for (let i = matched.length - 1; i >= 0; i--) {
      const path = matched[i]?.path
      if (typeof path === 'string' && !path.endsWith('/*') && !path.includes('/*')) {
        return path
      }
    }
  }
  // routePath is the registered path of the *current* middleware/handler;
  // when a concrete route handled the request it is the right value.
  if (c.req.routePath && !c.req.routePath.endsWith('/*')) return c.req.routePath
  return c.req.path
}

export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const headers = Object.fromEntries(
      Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v as string]),
    )
    const parentCtx = extractContextFromHeaders(headers)
    const tracer = getTracer('whiteboard.http')
    const span = tracer.startSpan(
      // Provisional name; renamed once the route is known.
      `${c.req.method} ${c.req.path}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: c.req.method,
          [ATTR_URL_PATH]: c.req.path,
          [ATTR_USER_AGENT_ORIGINAL]: headers['user-agent'],
        },
      },
      parentCtx,
    )
    const ctxWithSpan = trace.setSpan(parentCtx, span)
    try {
      await context.with(ctxWithSpan, () => next())
      const route = resolveMatchedRoute(c)
      span.updateName(`${c.req.method} ${route}`)
      span.setAttribute(ATTR_HTTP_ROUTE, route)
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, c.res.status)
      if (c.res.status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
    } catch (err) {
      span.setAttribute(ATTR_HTTP_ROUTE, resolveMatchedRoute(c))
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      throw err
    } finally {
      span.end()
    }
  }
}
