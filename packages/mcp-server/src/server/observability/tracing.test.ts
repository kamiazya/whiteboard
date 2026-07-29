import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractContextFromHeaders,
  getTracer,
  initTracing,
  injectContextIntoHeaders,
  MCP_ATTR,
  resetTracingForTesting,
  SERVICE_NAME,
  StderrSpanExporter,
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
    const listenersBefore = process.listenerCount('SIGTERM')
    const h1 = await initTracing()
    const h2 = await initTracing()
    expect(h1).toBeNull()
    expect(h2).toBeNull()
    // No SDK was started so no process listeners should have been added.
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore)
    // shutdownTracing must resolve immediately (no active handle to tear down).
    await expect(shutdownTracing()).resolves.toBeUndefined()
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

  it('injectContextIntoHeaders returns the same carrier object and writes at least one header when a span context is active', () => {
    // Extract a real span context so the propagator has something to inject.
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const ctx = extractContextFromHeaders({ traceparent })
    const headers: Record<string, string> = {}
    const result = injectContextIntoHeaders(headers, ctx)
    // Reference equality: the carrier must be returned unchanged.
    expect(result).toBe(headers)
    // Injection must have written at least one W3C header.
    expect(Object.keys(headers).length).toBeGreaterThan(0)
  })

  it('round-trips a traceparent through extract then inject with a fully conforming W3C traceparent', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const traceparent = `00-${traceId}-00f067aa0ba902b7-01`
    const inCtx = extractContextFromHeaders({ traceparent })
    const outHeaders: Record<string, string> = {}
    injectContextIntoHeaders(outHeaders, inCtx)
    // The injected traceparent must conform to the W3C trace-context spec:
    // 00-<32-hex traceId>-<16-hex spanId>-<2-hex flags>
    expect(outHeaders.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    // And must carry the original traceId so the downstream service joins
    // the same trace.
    expect(outHeaders.traceparent).toContain(traceId)
  })
})

// ---------------------------------------------------------------------------
// initTracing() — options.role and WHITEBOARD_OTEL_ROLE env var
// ---------------------------------------------------------------------------

describe('initTracing() role resolution', () => {
  beforeEach(() => {
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await shutdownTracing()
  })

  it('uses options.role when provided', async () => {
    const handle = await initTracing({ role: 'http-daemon' })
    expect(handle).not.toBeNull()
  })

  it('falls back to WHITEBOARD_OTEL_ROLE env var when options.role is absent', async () => {
    vi.stubEnv('WHITEBOARD_OTEL_ROLE', 'stdio-mcp')
    const handle = await initTracing()
    expect(handle).not.toBeNull()
    vi.unstubAllEnvs()
    // Re-stub so afterEach cleanup works cleanly.
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
  })

  it('falls back to "unknown" when neither options.role nor env var is set', async () => {
    vi.stubEnv('WHITEBOARD_OTEL_ROLE', '')
    const handle = await initTracing()
    expect(handle).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// initTracing() — signal-handler registration and cleanup
// ---------------------------------------------------------------------------

describe('initTracing() signal-handler flush registration', () => {
  beforeEach(() => {
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await shutdownTracing()
  })

  it('registers once-listeners on SIGTERM, SIGINT, and beforeExit after init', async () => {
    const beforeSIGTERM = process.listenerCount('SIGTERM')
    const beforeSIGINT = process.listenerCount('SIGINT')
    const beforeExit = process.listenerCount('beforeExit')

    await initTracing()

    expect(process.listenerCount('SIGTERM')).toBe(beforeSIGTERM + 1)
    expect(process.listenerCount('SIGINT')).toBe(beforeSIGINT + 1)
    expect(process.listenerCount('beforeExit')).toBe(beforeExit + 1)
  })

  it('removes signal listeners when shutdownTracing() is called so repeated cycles do not accumulate listeners', async () => {
    const baselineSIGTERM = process.listenerCount('SIGTERM')
    const baselineSIGINT = process.listenerCount('SIGINT')
    const baselineBeforeExit = process.listenerCount('beforeExit')

    await initTracing()
    await shutdownTracing()

    expect(process.listenerCount('SIGTERM')).toBe(baselineSIGTERM)
    expect(process.listenerCount('SIGINT')).toBe(baselineSIGINT)
    expect(process.listenerCount('beforeExit')).toBe(baselineBeforeExit)
  })

  it('does not accumulate listeners across repeated init/shutdown cycles', async () => {
    const baselineSIGTERM = process.listenerCount('SIGTERM')

    for (let i = 0; i < 3; i++) {
      await initTracing()
      await shutdownTracing()
    }

    expect(process.listenerCount('SIGTERM')).toBe(baselineSIGTERM)
  })

  it('does not register SIGTERM/SIGINT listeners when installSignalHandlers is false, so a coordinator like installStdioLifecycle stays the sole signal-driven caller of sdk.shutdown()', async () => {
    const beforeSIGTERM = process.listenerCount('SIGTERM')
    const beforeSIGINT = process.listenerCount('SIGINT')
    const beforeExit = process.listenerCount('beforeExit')

    await initTracing({ installSignalHandlers: false })

    expect(process.listenerCount('SIGTERM')).toBe(beforeSIGTERM)
    expect(process.listenerCount('SIGINT')).toBe(beforeSIGINT)
    // beforeExit only fires on natural event-loop drain, never on a signal,
    // so it never races an external shutdown coordinator and stays wired.
    expect(process.listenerCount('beforeExit')).toBe(beforeExit + 1)
  })
})

// ---------------------------------------------------------------------------
// initTracing() — OTLP exporter branch
// ---------------------------------------------------------------------------

describe('initTracing() with OTEL_EXPORTER_OTLP_ENDPOINT set', () => {
  beforeEach(() => {
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    // Point at a local address — no real collector is required because the
    // OTLP exporter only attempts delivery when spans are exported, not at
    // SDK start time.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await shutdownTracing()
  })

  it('returns a TracingHandle when OTLP endpoint is configured', async () => {
    const handle = await initTracing()
    expect(handle).not.toBeNull()
    expect(typeof handle!.shutdown).toBe('function')
  })

  it('handle.shutdown() resolves without throwing for OTLP path', async () => {
    const handle = await initTracing()
    await expect(handle!.shutdown()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// flushOnExit — signal-fired body calls sdk.shutdown() and catch branch
// ---------------------------------------------------------------------------

describe('flushOnExit — signal-handler body', () => {
  // Mocks NodeSDK so sdk.shutdown() is observable (vi.doMock only affects
  // subsequent dynamic imports) and stubs the env so tracing is enabled. The
  // caller imports a fresh copy of the module under test afterwards — the
  // import specifier must stay a static literal so Vite's dynamic-import
  // analyzer can resolve it.
  function mockSdkAndEnableTracing(shutdownSpy: ReturnType<typeof vi.fn>): void {
    vi.doMock('@opentelemetry/sdk-node', async () => {
      const actual =
        await vi.importActual<typeof import('@opentelemetry/sdk-node')>('@opentelemetry/sdk-node')
      return {
        ...actual,
        NodeSDK: class MockNodeSDK {
          start() {}
          shutdown = shutdownSpy
        },
      }
    })

    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  }

  // beforeExit fires the registered once-listener; wait a macrotask for the
  // async flushOnExit body to settle.
  async function emitBeforeExitAndSettle(): Promise<void> {
    process.emit('beforeExit', 0)
    await new Promise((r) => setTimeout(r, 0))
  }

  let flushTestHandle: Awaited<ReturnType<typeof import('./tracing.js').initTracing>> = null

  afterEach(() => {
    // Always remove signal listeners regardless of assertion outcome to prevent
    // SIGTERM/SIGINT listeners registered by a fresh module import from
    // leaking into subsequent tests.
    flushTestHandle?.removeSignalListeners()
    flushTestHandle = null
    vi.doUnmock('@opentelemetry/sdk-node')
    vi.restoreAllMocks()
  })

  it('emitting beforeExit calls sdk.shutdown() once', async () => {
    const shutdownSpy = vi.fn().mockResolvedValue(undefined)
    mockSdkAndEnableTracing(shutdownSpy)

    const { initTracing: init, resetTracingForTesting: reset } = await import(
      // biome-ignore lint/style/useTemplate: string concat is intentional — Vite treats template literals in dynamic import() differently from concatenation
      './tracing.js?flush-body=' + Date.now()
    )
    reset()
    flushTestHandle = await init()
    expect(flushTestHandle).not.toBeNull()

    await emitBeforeExitAndSettle()

    expect(shutdownSpy).toHaveBeenCalledOnce()

    // The listener was registered with process.once — a second beforeExit
    // must not invoke shutdown again, catching an accidental once→on regression.
    await emitBeforeExitAndSettle()
    expect(shutdownSpy).toHaveBeenCalledOnce()
  })

  it('flushOnExit swallows a shutdown rejection and logs a warning — never throws', async () => {
    const shutdownSpy = vi.fn().mockRejectedValue(new Error('sdk shutdown boom'))
    mockSdkAndEnableTracing(shutdownSpy)

    // Capture log records to assert the warning is emitted via getLogger.
    // Always restore in finally so the elevated level and capture destination
    // cannot leak into subsequent tests when an earlier assertion throws.
    const { captureLogsForTests } = await import('../log.js')
    const capture = captureLogsForTests('warning')

    try {
      const { initTracing: init, resetTracingForTesting: reset } = await import(
        // biome-ignore lint/style/useTemplate: string concat is intentional — Vite treats template literals in dynamic import() differently from concatenation
        './tracing.js?flush-catch=' + Date.now()
      )
      reset()
      flushTestHandle = await init()
      expect(flushTestHandle).not.toBeNull()

      await emitBeforeExitAndSettle()

      // sdk.shutdown() was called (and rejected).
      expect(shutdownSpy).toHaveBeenCalledOnce()

      // The rejection must be swallowed — no unhandled rejection reaches the
      // test — and the catch branch must warn via getLogger('tracing').
      const warnings = capture.records.filter(
        (r) => r.level === 'warning' && r.msg === 'shutdown failed',
      )
      expect(warnings).toHaveLength(1)
    } finally {
      capture.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// initTracing() — error / catch path
// ---------------------------------------------------------------------------

describe('initTracing() catch path', () => {
  beforeEach(() => {
    vi.stubEnv('WHITEBOARD_OTEL', '1')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
  })

  it('returns null when dynamic import fails', async () => {
    // Simulate a dynamic-import failure by stubbing the module. Because
    // vi.mock is hoisted, we use vi.doMock with a resetModules boundary.
    // The simplest approach is to mock @opentelemetry/sdk-node to throw.
    vi.doMock('@opentelemetry/sdk-node', () => {
      throw new Error('sdk-node unavailable')
    })
    // Re-import the module under test so it picks up the mock.
    const { initTracing: initTracingFresh, resetTracingForTesting: reset } = await import(
      // biome-ignore lint/style/useTemplate: string concat is intentional — Vite treats template literals in dynamic import() differently from concatenation
      './tracing.js?bust=' + Date.now()
    )
    reset()
    const handle = await initTracingFresh()
    expect(handle).toBeNull()
    vi.doUnmock('@opentelemetry/sdk-node')
  })
})

// ---------------------------------------------------------------------------
// StderrSpanExporter — direct unit tests
// ---------------------------------------------------------------------------

// Build a minimal span-like object that satisfies the exporter's input type.
function makeSpan(name = 'test-span') {
  return {
    name,
    kind: 0,
    startTime: [0, 0] as [number, number],
    endTime: [1, 0] as [number, number],
    duration: [1, 0] as [number, number],
    attributes: {},
    status: { code: 0 },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    parentSpanContext: undefined,
  }
}

describe('StderrSpanExporter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls resultCallback with code=0 and writes JSON to stderr on success', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exporter = new StderrSpanExporter(undefined)
    const callback = vi.fn()

    exporter.export([makeSpan()], callback)

    expect(process.stderr.write).toHaveBeenCalledOnce()
    const written = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    const parsed = JSON.parse(written.trim())
    expect(parsed.name).toBe('test-span')
    expect(callback).toHaveBeenCalledWith({ code: 0 })
  })

  it('calls resultCallback with code=1 and a wrapped Error when process.stderr.write throws', () => {
    const writeError = new Error('write error')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw writeError
    })
    const exporter = new StderrSpanExporter(undefined)
    const callback = vi.fn()

    exporter.export([makeSpan()], callback)

    expect(callback).toHaveBeenCalledWith({ code: 1, error: writeError })
  })

  it('wraps a non-Error thrown value in an Error when calling resultCallback', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw 'string error'
    })
    const exporter = new StderrSpanExporter(undefined)
    const callback = vi.fn()

    exporter.export([makeSpan()], callback)

    const result = (callback as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      code: number
      error: Error
    }
    expect(result.code).toBe(1)
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toBe('string error')
  })

  it('shutdown() and forceFlush() resolve without throwing', async () => {
    const exporter = new StderrSpanExporter(undefined)
    await expect(exporter.shutdown()).resolves.toBeUndefined()
    await expect(exporter.forceFlush()).resolves.toBeUndefined()
  })
})
