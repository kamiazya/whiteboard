import { context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tracingMiddleware } from './http-tracing.js'

// Spin up a real (in-memory) tracer provider so the middleware exercises
// the production OTel API rather than a no-op tracer. Each test resets
// the exporter so spans from one case do not leak into the next.
let provider: BasicTracerProvider
let exporter: InMemorySpanExporter

beforeEach(() => {
  exporter = new InMemorySpanExporter()
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  trace.setGlobalTracerProvider(provider)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
})

afterEach(async () => {
  await provider.shutdown()
  trace.disable()
  propagation.disable()
  context.disable()
  vi.restoreAllMocks()
})

function buildApp() {
  const app = new Hono()
  app.use('*', tracingMiddleware())
  app.get('/api/runtime/storage', (c) => c.json({ ok: true }))
  app.post('/api/workspaces/:wid/documents/:path/compact', (c) =>
    c.json({ path: c.req.param('path') }),
  )
  app.get('/health', (c) => c.text('ok'))
  return app
}

describe('tracingMiddleware http.route attribute', () => {
  it('records the matched Hono route, not the wildcard middleware path', async () => {
    const app = buildApp()
    const res = await app.request('/api/runtime/storage')
    expect(res.status).toBe(200)
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]
    // Locked: the middleware MUST not leak the wildcard pattern. Surfacing
    // the actual matched route is the whole point of http.route.
    expect(span.attributes['http.route']).not.toBe('/*')
    expect(span.attributes['http.route']).toBe('/api/runtime/storage')
    expect(span.attributes['url.path']).toBe('/api/runtime/storage')
  })

  it('captures parameterised routes verbatim (preserves :wid / :path)', async () => {
    const app = buildApp()
    const res = await app.request('/api/workspaces/ws_a/documents/design%2Flogin/compact', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const span = exporter.getFinishedSpans()[0]
    // The whole point of low-cardinality http.route is that all
    // ws_a, ws_b, … collapse onto the same template.
    expect(span.attributes['http.route']).toBe('/api/workspaces/:wid/documents/:path/compact')
    // url.path stays high-cardinality so debugging single requests still works.
    expect(span.attributes['url.path']).toBe(
      '/api/workspaces/ws_a/documents/design%2Flogin/compact',
    )
  })

  it('records the http method + status code in semconv attributes', async () => {
    const app = buildApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const span = exporter.getFinishedSpans()[0]
    expect(span.attributes['http.request.method']).toBe('GET')
    expect(span.attributes['http.response.status_code']).toBe(200)
    expect(span.attributes['http.route']).toBe('/health')
  })

  it('omits http.route and uses {method} span name for unmatched 404 paths', async () => {
    // Per OpenTelemetry HTTP semconv v1.41+, server spans MUST NOT use
    // the raw request path as a substitute for http.route, and the span
    // name MUST be `{method}` alone when no low-cardinality route
    // template is available. Without this, a single 404 hit on a typoed
    // URL pollutes per-route latency aggregations with a unique label.
    const app = buildApp()
    const res = await app.request('/totally/made/up/url')
    expect(res.status).toBe(404)
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]
    expect(span.attributes['http.route']).toBeUndefined()
    expect(span.name).toBe('GET')
    // url.path stays high-cardinality on purpose — it is the per-request
    // attribute, not the per-route grouper.
    expect(span.attributes['url.path']).toBe('/totally/made/up/url')
  })
})
