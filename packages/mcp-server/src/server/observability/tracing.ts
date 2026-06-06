import { context, type Context, propagation, trace, type Tracer } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { getLogger } from '../log.js'

// Register the W3C trace-context propagator at module load so
// `extract` / `inject` work even when the heavy SDK has not been
// started. Tracing is a no-op without a TracerProvider, but trace
// CONTEXT propagation is meaningful even then — it lets ws.ts read a
// caller's traceparent and pass it onward without forcing every test or
// dev run to register the propagator manually.
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

// OpenTelemetry skeleton.
//
// The @opentelemetry/api surface is always loaded (it's a tiny no-op when no
// SDK is registered, so spans cost nothing). The heavy SDK is wired only via
// initTracing(), which dynamically imports @opentelemetry/sdk-node so the
// dependency is paid for only when tracing is on.
//
// Default off. The runtime opts in by setting WHITEBOARD_OTEL=1 — that wires
// either the OTLP HTTP exporter (when OTEL_EXPORTER_OTLP_ENDPOINT is set) or
// the SDK's stdout console exporter so traces are visible during dev.
//
// Cross-process trace propagation uses the W3C `traceparent` header; the
// MCP semantic-convention names from
// https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/
// are exposed via MCP_ATTR_* below so call sites do not need to know the
// raw strings.

export const SERVICE_NAME = 'whiteboard-mcp'

// MCP semantic-convention attribute keys. Kept narrow on purpose — the spec
// is in flux, so we only commit to the small subset we actively populate.
export const MCP_ATTR = {
  METHOD_NAME: 'mcp.method.name',
  TOOL_NAME: 'mcp.tool.name',
  REQUEST_ID: 'mcp.request.id',
  SESSION_ID: 'mcp.session.id',
  PROTOCOL_VERSION: 'mcp.protocol.version',
} as const

// Stderr-safe console exporter. Bound late to the SDK's tracing namespace
// so we do not depend on @opentelemetry/sdk-trace-base directly. Each span
// is a JSON line; a downstream collector or `jq` can stitch them into
// timelines without an OTLP backend.
export class StderrSpanExporter {
  // The shape `tracing` exposes here matches @opentelemetry/sdk-trace-base.
  // We accept it as opaque to keep the dynamic import boundary clean.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_tracing: unknown) {}
  export(
    spans: ReadonlyArray<{
      name: string
      kind: number
      startTime: [number, number]
      endTime: [number, number]
      duration: [number, number]
      attributes: Record<string, unknown>
      status: { code: number; message?: string }
      spanContext(): { traceId: string; spanId: string }
      parentSpanContext?: { spanId: string } | undefined
    }>,
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void {
    try {
      for (const s of spans) {
        const ctx = s.spanContext()
        process.stderr.write(
          `${JSON.stringify({
            time: new Date().toISOString(),
            level: 'trace',
            scope: 'otel',
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            parentSpanId: s.parentSpanContext?.spanId,
            name: s.name,
            kind: s.kind,
            durationNs: s.duration[0] * 1e9 + s.duration[1],
            attributes: s.attributes,
            status: s.status,
          })}\n`,
        )
      }
      resultCallback({ code: 0 })
    } catch (err) {
      resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

interface InitTracingOptions {
  // Logical service name. Defaults to "whiteboard-mcp" plus a `.role`
  // attribute so the same name works for both the HTTP daemon and stdio
  // MCP entrypoint without collapsing into a single trace stream.
  role?: string
}

interface TracingHandle {
  shutdown(): Promise<void>
  /** Removes the process signal listeners registered during init. */
  removeSignalListeners(): void
}

let activeHandle: TracingHandle | null = null

function envFlag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'yes'
}

export function tracingEnabled(): boolean {
  return envFlag('WHITEBOARD_OTEL') || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT
}

// Lazy SDK init. Imports are dynamic so a default-disabled run never pays
// the sdk-node load cost.
export async function initTracing(options: InitTracingOptions = {}): Promise<TracingHandle | null> {
  if (activeHandle) return activeHandle
  if (!tracingEnabled()) return null

  const role = options.role ?? process.env.WHITEBOARD_OTEL_ROLE ?? 'unknown'
  try {
    const [
      { NodeSDK, tracing: sdkTracing },
      { resourceFromAttributes },
      { OTLPTraceExporter },
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    ] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/semantic-conventions'),
    ])

    // Route exporter selection so stdio MCP can never accidentally write
    // spans to stdout (which would corrupt the JSON-RPC channel).
    //   1. OTEL_EXPORTER_OTLP_ENDPOINT set → OTLP HTTP exporter.
    //   2. Otherwise fall back to a stderr-only JSON exporter so dev runs
    //      see *something*. The SDK ships a console exporter, but its
    //      default sink is stdout — unsafe for stdio MCP.
    const traceExporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OTLPTraceExporter()
      : new StderrSpanExporter(sdkTracing)

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: PACKAGE_VERSION,
      'whiteboard.role': role,
    })

    // Use SimpleSpanProcessor so spans flush as soon as they end, not on
    // a 5-second batch. Short-lived processes, especially the stdio MCP
    // entrypoint, can otherwise exit before the batch ships.
    const sdk = new NodeSDK({
      resource,
      spanProcessors: [new sdkTracing.SimpleSpanProcessor(traceExporter)],
    })
    sdk.start()

    // Flush spans on shutdown signals so dev runs see complete traces.
    // Keep references to each listener so shutdownTracing() can remove them
    // and prevent accumulation across repeated init/shutdown cycles.
    const flushOnExit = async () => {
      try {
        await sdk.shutdown()
      } catch (err) {
        getLogger('tracing').warning({ err }, 'shutdown failed')
      }
    }
    const onSIGTERM = () => void flushOnExit()
    const onSIGINT = () => void flushOnExit()
    const onBeforeExit = () => void flushOnExit()
    process.once('SIGTERM', onSIGTERM)
    process.once('SIGINT', onSIGINT)
    process.once('beforeExit', onBeforeExit)

    const handle: TracingHandle = {
      async shutdown(): Promise<void> {
        await sdk.shutdown()
      },
      removeSignalListeners(): void {
        process.off('SIGTERM', onSIGTERM)
        process.off('SIGINT', onSIGINT)
        process.off('beforeExit', onBeforeExit)
      },
    }
    activeHandle = handle

    getLogger('tracing').info({ role, otlp: !!traceExporter }, 'tracing initialised')
    return handle
  } catch (err) {
    getLogger('tracing').warning({ err }, 'initTracing failed; tracing disabled')
    return null
  }
}

export async function shutdownTracing(): Promise<void> {
  const h = activeHandle
  if (!h) return
  activeHandle = null
  h.removeSignalListeners()
  await h.shutdown()
}

// Reset hook for tests so a per-test initTracing() does not leak between
// describe blocks.
export function resetTracingForTesting(): void {
  activeHandle = null
}

export function getTracer(name = SERVICE_NAME): Tracer {
  return trace.getTracer(name, PACKAGE_VERSION)
}

// Convenience: extract a Context from arbitrary header carriers (Hono uses
// lowercase header keys, MCP transports may differ).
export function extractContextFromHeaders(headers: Record<string, string | undefined>): Context {
  return propagation.extract(context.active(), headers, {
    get(carrier, key) {
      return carrier[key.toLowerCase()] ?? undefined
    },
    keys(carrier) {
      return Object.keys(carrier)
    },
  })
}

// Convenience: write the active context's traceparent into outgoing headers
// so downstream services join the same trace.
export function injectContextIntoHeaders(
  headers: Record<string, string>,
  ctx: Context = context.active(),
): Record<string, string> {
  propagation.inject(ctx, headers, {
    set(carrier, key, value) {
      carrier[key] = value
    },
  })
  return headers
}
