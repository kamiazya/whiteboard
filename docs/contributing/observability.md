# Observability (OpenTelemetry)

The MCP server ships an OpenTelemetry skeleton that traces both the HTTP
daemon and the stdio MCP entrypoint. All instrumentation is no-op by
default — the SDK is only loaded when one of the env vars below is set, so
the production cost is zero unless you opt in.

## Quick start (local dev)

```bash
# Spans go to stderr as JSON lines, safe alongside stdio JSON-RPC.
WHITEBOARD_OTEL=1 pnpm mcp:http:dev
```

Each tool call / HTTP request prints a single span line on stderr:

```
{"time":"2026-05-02T03:00:00.000Z","level":"trace","scope":"otel","traceId":"…","spanId":"…","name":"mcp.tool.call canvas_create","attributes":{"mcp.tool.name":"canvas_create",…}}
```

## Forwarding to a collector

```bash
WHITEBOARD_OTEL=1 \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  pnpm mcp:http:dev
```

Compatible backends: any OTLP/HTTP receiver — Jaeger, Tempo, Honeycomb,
SigNoz, Grafana Cloud, etc.

## What is instrumented today

| Surface         | Span name pattern                      | Key attributes                                                  |
| --------------- | -------------------------------------- | --------------------------------------------------------------- |
| HTTP route      | `{METHOD} {route}`                     | `http.request.method`, `http.route`, `url.path`, status code    |
| MCP tool call   | `mcp.tool.call {name}`                 | `mcp.method.name`, `mcp.tool.name`, `mcp.request.id`            |
| Service info    | (resource)                             | `service.name=whiteboard-mcp`, `service.version`, `whiteboard.role` |

`whiteboard.role` distinguishes the entrypoint:

- `http` — HTTP-only mode (`pnpm mcp:http`)
- `daemon` — same binary in `--daemon` mode
- `stdio-mcp` — stdio MCP entry (`packages/mcp-server/src/server/mcp/index.ts`)

The MCP attribute names follow the in-flight semantic convention at
<https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/>.

## Cross-process propagation

Inbound HTTP requests honour the W3C `traceparent` header, so a caller
that already has a span (e.g. another MCP server) can stitch its trace
into the daemon's trace without extra wiring.

Outbound calls from the MCP daemon-client (`client.request(...)` inside
each tool) inject `traceparent` automatically, so an `mcp.tool.call` span
parents the HTTP request span on the daemon side.

## Browser tracing (opt-in)

The UI ships with a lazy SDK loader, so the default bundle does not pay
the cost. Open the dev console on the canvas page and:

```js
localStorage.setItem('whiteboard:otel', '1')
// optional: forward to a local collector
localStorage.setItem('whiteboard:otel-otlp', 'http://localhost:4318')
location.reload()
```

After reload, every `apiFetch` carries a `traceparent` header. With no
collector, the SDK uses the console exporter so spans appear in DevTools.
With an OTLP HTTP endpoint, spans land in your collector alongside the
matching server-side span.

Programmatic alternative inside the page:

```js
await window.__whiteboardEnableTracing({ otlpEndpoint: '…' })
```

## WS instrumentation

Each binary Loro update opens an `ws.message.binary` span on the server
with `whiteboard.workspace_id` / `whiteboard.slug` / `whiteboard.update_bytes`
attributes.

If the client sends a `ws_trace` text frame (shape:
`{type: 'ws_trace', traceparent, tracestate?}`) immediately before a
binary update, the server adopts that traceparent as the parent of the
next `ws.message.binary` span — letting a UI-driven edit stitch
end-to-end. `buildWsTracePayload()` in `app/lib/browser-tracing.ts`
builds the payload from the active OTel context; the WS layer hooked to
useWhiteboardSync should call it before each binary send. When no
`ws_trace` precedes the frame, the span runs parentless and still gives
a per-update timeline.

## Browser fetch instrumentation

`enableBrowserTracing()` registers `@opentelemetry/instrumentation-fetch`
so user-initiated `fetch()` calls open a client span and the OTel
propagator attaches `traceparent` automatically. Same-origin requests and
`http://127.0.0.1:*` / `http://localhost:*` are CORS-allowed for trace
header propagation by default.

## Disabling

Unset both `WHITEBOARD_OTEL` and `OTEL_EXPORTER_OTLP_ENDPOINT` (the
default in production / CI). The SDK will not be loaded; the `getTracer()`
helper resolves to the OpenTelemetry no-op tracer, so call sites stay
compile-time-correct without paying any runtime cost.
