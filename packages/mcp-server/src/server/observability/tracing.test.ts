import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractContextFromHeaders,
  getTracer,
  injectContextIntoHeaders,
  initTracing,
  MCP_ATTR,
  resetTracingForTesting,
  SERVICE_NAME,
  shutdownTracing,
  tracingEnabled,
} from './tracing.js'

// Isolate module-level state (activeHandle) between tests.
beforeEach(() => {
  resetTracingForTesting()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetTracingForTesting()
})

// ---------------------------------------------------------------------------
// Static exports
// ---------------------------------------------------------------------------

describe('SERVICE_NAME', () => {
  it('equals "whiteboard-mcp"', () => {
    expect(SERVICE_NAME).toBe('whiteboard-mcp')
  })
})

describe('MCP_ATTR', () => {
  it('exposes the expected attribute key set', () => {
    expect(MCP_ATTR.METHOD_NAME).toBe('mcp.method.name')
    expect(MCP_ATTR.TOOL_NAME).toBe('mcp.tool.name')
    expect(MCP_ATTR.REQUEST_ID).toBe('mcp.request.id')
    expect(MCP_ATTR.SESSION_ID).toBe('mcp.session.id')
    expect(MCP_ATTR.PROTOCOL_VERSION).toBe('mcp.protocol.version')
  })
})

// ---------------------------------------------------------------------------
// tracingEnabled() — reads env flags
// ---------------------------------------------------------------------------

describe('tracingEnabled()', () => {
  it('returns false when neither WHITEBOARD_OTEL nor OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
    vi.stubEnv('WHITEBOARD_OTEL', '')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    expect(tracingEnabled()).toBe(false)
  })

  it('returns true when WHITEBOARD_OTEL=1', () => {
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    expect(tracingEnabled()).toBe(true)
  })

  it('returns true when WHITEBOARD_OTEL=true', () => {
    vi.stubEnv('WHITEBOARD_OTEL', 'true')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    expect(tracingEnabled()).toBe(true)
  })

  it('returns true when WHITEBOARD_OTEL=yes', () => {
    vi.stubEnv('WHITEBOARD_OTEL', 'yes')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    expect(tracingEnabled()).toBe(true)
  })

  it('returns false when WHITEBOARD_OTEL=0 (flag not asserted)', () => {
    vi.stubEnv('WHITEBOARD_OTEL', '0')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    expect(tracingEnabled()).toBe(false)
  })

  it('returns true when OTEL_EXPORTER_OTLP_ENDPOINT is set even without WHITEBOARD_OTEL', () => {
    vi.stubEnv('WHITEBOARD_OTEL', '')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector:4318')
    expect(tracingEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// initTracing() — disabled path (no env var → returns null, no SDK loaded)
// ---------------------------------------------------------------------------

describe('initTracing() when tracing is disabled', () => {
  beforeEach(() => {
    vi.stubEnv('WHITEBOARD_OTEL', '')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
  })

  it('returns null so callers know no provider is active', async () => {
    const handle = await initTracing()
    expect(handle).toBeNull()
  })

  it('is safe to call multiple times — stays null without side-effects', async () => {
    const h1 = await initTracing()
    const h2 = await initTracing()
    expect(h1).toBeNull()
    expect(h2).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// initTracing() — idempotency guard (enabled path, real SDK modules)
// ---------------------------------------------------------------------------
// These tests DO spin up a real NodeSDK with a stderr-only exporter because
// OTEL_EXPORTER_OTLP_ENDPOINT is unset. The SDK itself is lightweight when
// only SimpleSpanProcessor + stderr exporter are wired — no network I/O
// occurs. We shut down cleanly after each test via resetTracingForTesting()
// plus explicit shutdownTracing().
// ---------------------------------------------------------------------------

describe('initTracing() when tracing is enabled', () => {
  beforeEach(() => {
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    // Suppress stderr span JSON output during tests.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    // Always shut down before resetTracingForTesting clears the handle so
    // the SDK's internal state is cleaned up too.
    await shutdownTracing()
  })

  it('returns a TracingHandle with a shutdown function', async () => {
    const handle = await initTracing()
    expect(handle).not.toBeNull()
    expect(typeof handle!.shutdown).toBe('function')
  })

  it('is idempotent — calling initTracing twice returns the exact same handle', async () => {
    const h1 = await initTracing()
    const h2 = await initTracing()
    expect(h1).not.toBeNull()
    // Must be reference-equal: the second call must short-circuit.
    expect(h1).toBe(h2)
  })

  it('handle.shutdown() resolves without throwing', async () => {
    const handle = await initTracing()
    await expect(handle!.shutdown()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// shutdownTracing()
// ---------------------------------------------------------------------------

describe('shutdownTracing()', () => {
  it('is safe to call when no handle is active (no throw)', async () => {
    vi.stubEnv('WHITEBOARD_OTEL', '')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    await expect(shutdownTracing()).resolves.toBeUndefined()
  })

  it('clears the active handle so subsequent initTracing re-initialises from scratch', async () => {
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const h1 = await initTracing()
    expect(h1).not.toBeNull()

    await shutdownTracing()

    // After shutdown the handle slot is clear; a fresh initTracing must
    // return a new (different) handle, not the old cached one.
    const h2 = await initTracing()
    expect(h2).not.toBeNull()
    expect(h2).not.toBe(h1)

    // Clean up the second SDK instance.
    await shutdownTracing()
  })
})

// ---------------------------------------------------------------------------
// getTracer()
// ---------------------------------------------------------------------------

describe('getTracer()', () => {
  it('returns a Tracer object (OTel API no-op when no provider is registered)', () => {
    const tracer = getTracer()
    expect(typeof tracer.startSpan).toBe('function')
  })

  it('accepts an explicit scope name', () => {
    const tracer = getTracer('custom-scope')
    expect(typeof tracer.startSpan).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// W3C traceparent propagation helpers
// ---------------------------------------------------------------------------

describe('W3C traceparent propagation', () => {
  it('extracts a traceparent header into a context object', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const ctx = extractContextFromHeaders({ traceparent })
    expect(ctx).toBeDefined()
    expect(typeof ctx).toBe('object')
  })

  it('returns an active context even when no traceparent header is present', () => {
    const ctx = extractContextFromHeaders({})
    expect(ctx).toBeDefined()
  })

  it('injectContextIntoHeaders returns the same carrier object', () => {
    const headers: Record<string, string> = {}
    const result = injectContextIntoHeaders(headers)
    expect(result).toBe(headers)
  })

  it('round-trips a traceparent through extract then inject', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const traceparent = `00-${traceId}-00f067aa0ba902b7-01`
    const inCtx = extractContextFromHeaders({ traceparent })
    const outHeaders: Record<string, string> = {}
    injectContextIntoHeaders(outHeaders, inCtx)
    // The injected traceparent must carry the original traceId so the
    // downstream service joins the same trace.
    expect(outHeaders['traceparent']).toContain(traceId)
  })
})
