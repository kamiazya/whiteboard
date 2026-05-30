// Optional browser-side OpenTelemetry init.
//
// `@opentelemetry/api` is a tiny no-op surface — we use `propagation.inject`
// from it unconditionally in apiFetch so a `traceparent` header is added
// when (and only when) a real SDK has been registered. Calling
// `enableBrowserTracing()` is what registers that SDK; before that, the
// no-op returns an empty context and the header is not set.
//
// The SDK packages (`@opentelemetry/sdk-trace-web`, `context-zone`) are
// dynamically imported here so the default bundle does not pay their cost.

import { context, propagation } from '@opentelemetry/api'

export function injectTraceContextIntoHeaders(
  headers: Headers,
  ctx = context.active(),
): void {
  propagation.inject(ctx, headers, {
    set(carrier, key, value) {
      ;(carrier as Headers).set(key, value)
    },
  })
}

// Build a `ws_trace` text-frame payload from the active OTel context, or
// return null when no traceparent could be derived (browser tracing
// disabled). The caller is responsible for `JSON.stringify`ing and
// sending — we keep this helper protocol-agnostic so the WS hook in
// useWhiteboardSync (or wherever else) can reuse it.
export function buildWsTracePayload(
  ctx = context.active(),
): { type: 'ws_trace'; traceparent: string; tracestate?: string } | null {
  const carrier: Record<string, string> = {}
  propagation.inject(ctx, carrier, {
    set(c, key, value) {
      ;(c as Record<string, string>)[key] = value
    },
  })
  const traceparent = carrier.traceparent
  if (!traceparent) return null
  const tracestate = carrier.tracestate
  return tracestate
    ? { type: 'ws_trace', traceparent, tracestate }
    : { type: 'ws_trace', traceparent }
}

let started = false
// Loose typing on purpose: `registerInstrumentations` accepts any
// instrumentation regardless of its concrete config type, and we only
// need `.disable()` here. Pinning the array to the full
// `Instrumentation<InstrumentationConfig>[]` shape forces a redundant
// dynamic import just for the types in lazy-init code.
type DisposableInstrumentation = { disable(): void }
let registeredInstrumentations: DisposableInstrumentation[] = []

export interface BrowserTracingOptions {
  // OTLP HTTP exporter endpoint. Without one, spans stay in-memory and
  // can be inspected via the global tracer in the dev console — useful
  // for verifying that traceparent flows without a backend.
  otlpEndpoint?: string
  // Service name attribute. Defaults to "whiteboard-ui".
  serviceName?: string
}

export async function enableBrowserTracing(
  options: BrowserTracingOptions = {},
): Promise<void> {
  if (started) return
  started = true

  const [
    { WebTracerProvider, BatchSpanProcessor, ConsoleSpanExporter },
    { ZoneContextManager },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME },
    { registerInstrumentations },
    { FetchInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-web'),
    import('@opentelemetry/context-zone'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@opentelemetry/instrumentation'),
    import('@opentelemetry/instrumentation-fetch'),
  ])

  const exporter = options.otlpEndpoint
    ? new OTLPTraceExporter({ url: `${options.otlpEndpoint.replace(/\/$/, '')}/v1/traces` })
    : new ConsoleSpanExporter()

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? 'whiteboard-ui',
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  })
  provider.register({ contextManager: new ZoneContextManager() })

  // Auto-instrument `fetch` so user-initiated network calls open a
  // client span and the OTel context propagator attaches `traceparent`
  // to the outgoing request. Restrict cross-origin propagation to the
  // local daemon: an open propagator forces a CORS preflight on every
  // external asset / library host (most don't allow `traceparent`) and
  // leaks the local trace id to third parties. Same-origin requests do
  // not need an entry here — the instrumentation propagates them
  // unconditionally because there is no CORS gate.
  const fetchInstrumentation = new FetchInstrumentation({
    propagateTraceHeaderCorsUrls: [
      /^http:\/\/127\.0\.0\.1(:\d+)?\//,
      /^http:\/\/localhost(:\d+)?\//,
    ],
  })
  registeredInstrumentations = [fetchInstrumentation as DisposableInstrumentation]
  registerInstrumentations({ instrumentations: [fetchInstrumentation] })
}

// Test reset hook. Disables registered instrumentations + clears the
// idempotency flag so subsequent `enableBrowserTracing()` calls re-init
// against a fresh global tracer provider.
export function resetBrowserTracingForTests(): void {
  for (const i of registeredInstrumentations) {
    try {
      i.disable()
    } catch {
      // disable() is best-effort; instrumentations vary in error behaviour.
    }
  }
  registeredInstrumentations = []
  started = false
}

// Convenience entry the dev console can call:
//   `await window.__whiteboardEnableTracing?.()`
// main.tsx wires this so opt-in is one line.
declare global {
  interface Window {
    __whiteboardEnableTracing?: (options?: BrowserTracingOptions) => Promise<void>
  }
}
