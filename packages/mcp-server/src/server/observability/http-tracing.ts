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
// "/api/workspaces/:wid/canvases/:path/compact"), not the wildcard the
// middleware itself is registered under. We learn the matched route by
// inspecting `c.req.matchedRoutes` AFTER next() — at middleware-entry the
// router has not yet matched a downstream handler, so `c.req.routePath`
// reflects only the wildcard. The attribute exists primarily so dashboards
// can group by low-cardinality route, so getting that right matters more
// than naming the span at start time.

function resolveMatchedRoute(c: Parameters<MiddlewareHandler>[0]): string | undefined {
  // Hono populates `matchedRoutes` with every middleware + handler the
  // request hit, in order. Skip the wildcard middlewares (those whose
  // path contains "/*") and return the first concrete one.
  // Returns undefined for genuinely unmatched requests (404s, probes,
  // typos) — per OpenTelemetry HTTP semconv v1.41+, http.route MUST be
  // omitted in that case rather than substituted with the raw request
  // path, otherwise per-route latency dashboards collapse under
  // unique-per-request cardinality.
  type MatchedRoute = { path?: string; handler?: unknown; method?: string }
  const matched = (c.req as unknown as { matchedRoutes?: MatchedRoute[] }).matchedRoutes
  if (Array.isArray(matched)) {
    for (let i = matched.length - 1; i >= 0; i--) {
      const path = matched[i]?.path
      if (typeof path === 'string' && !path.includes('/*')) {
        return path
      }
    }
  }
  // routePath is the registered path of the *current* middleware/handler;
  // when a concrete route handled the request it is the right value.
  if (c.req.routePath && !c.req.routePath.includes('/*')) return c.req.routePath
  return undefined
}

export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const headers = Object.fromEntries(
      Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v as string]),
    )
    const parentCtx = extractContextFromHeaders(headers)
    const tracer = getTracer('whiteboard.http')
    const span = tracer.startSpan(
      // Provisional name; renamed once the route is known. Use the
      // method-only form for the provisional value too so an unmatched
      // 404 stays low-cardinality even if next() throws before we can
      // resolve a concrete route.
      c.req.method,
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
    const applyRoute = (): void => {
      const route = resolveMatchedRoute(c)
      if (route) {
        span.updateName(`${c.req.method} ${route}`)
        span.setAttribute(ATTR_HTTP_ROUTE, route)
      }
    }
    try {
      await context.with(ctxWithSpan, () => next())
      applyRoute()
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, c.res.status)
      if (c.res.status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
    } catch (err) {
      applyRoute()
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
