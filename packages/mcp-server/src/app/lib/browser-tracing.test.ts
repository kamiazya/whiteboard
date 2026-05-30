import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { context, propagation, trace } from '@opentelemetry/api'
import { enableBrowserTracing, injectTraceContextIntoHeaders } from './browser-tracing.js'
import { resetBrowserTracingForTests } from './browser-tracing.js'

afterEach(() => {
  resetBrowserTracingForTests()
  trace.disable()
  propagation.disable()
  context.disable()
  vi.restoreAllMocks()
})

describe('enableBrowserTracing', () => {
  it('registers fetch auto-instrumentation so an in-flight fetch becomes the parent of the inject() context', async () => {
    // Arrange: a fake fetch that records the headers it sees so we can
    // confirm traceparent ends up on the outgoing request — without ever
    // hitting the network.
    const seenHeaders: Record<string, string>[] = []
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h: Record<string, string> = {}
      const hdr = new Headers(init?.headers)
      hdr.forEach((v, k) => {
        h[k] = v
      })
      seenHeaders.push(h)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fakeFetch)

    await enableBrowserTracing()

    // Act: a plain fetch from page code. The fetch instrumentation must
    // open a client span and attach traceparent to the request — no
    // manual tracer.startSpan() on the caller's side.
    await fetch('/api/runtime/storage')

    // Assert
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect(seenHeaders[0]?.traceparent).toBeDefined()
    // The traceparent header is W3C-shaped: 00-<32hex>-<16hex>-<2hex>
    expect(seenHeaders[0]?.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    )
  })

  it('does not attach traceparent to cross-origin fetches outside the local daemon', async () => {
    // The propagateTraceHeaderCorsUrls list controls which cross-origin
    // requests get traceparent. A catch-all regex would force a CORS
    // preflight on every external script/asset host (most don't allow
    // traceparent) and leak the local trace id to third parties — so
    // every test asset host should NOT see the header.
    const seenHeaders: Record<string, string>[] = []
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => {
        h[k] = v
      })
      seenHeaders.push(h)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fakeFetch)

    await enableBrowserTracing()
    await fetch('https://cdn.example.com/library/foo.js')

    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect(seenHeaders[0]?.traceparent).toBeUndefined()
    expect(seenHeaders[0]?.tracestate).toBeUndefined()
  })

  it('still attaches traceparent to the local daemon (127.0.0.1) so daemon spans inherit the browser context', async () => {
    const seenHeaders: Record<string, string>[] = []
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => {
        h[k] = v
      })
      seenHeaders.push(h)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fakeFetch)

    await enableBrowserTracing()
    await fetch('http://127.0.0.1:3099/mcp')

    expect(seenHeaders[0]?.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    )
  })

  it('is idempotent — calling twice does not double-register fetch wrappers', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fakeFetch)
    await enableBrowserTracing()
    await enableBrowserTracing()
    await fetch('/api/runtime/storage')
    // The Single fetch must reach the underlying fetch exactly once even
    // if the caller toggled tracing twice — otherwise apiFetch in dev
    // could emit duplicate requests under repeated init.
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('injectTraceContextIntoHeaders is a no-op until tracing is enabled', () => {
    const headers = new Headers()
    injectTraceContextIntoHeaders(headers)
    expect(headers.get('traceparent')).toBeNull()
  })
})
