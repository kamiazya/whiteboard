import { describeThrown } from '@kamiazya/whiteboard-model'
import type {
  CallToolResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { getLogger } from '../log.js'
import { getTracer, MCP_ATTR } from '../observability/tracing.js'
import { callerReadsServerLog, toolErrorText } from '../security/mcp-caller.js'
import { runWithRequestLog } from './logging.js'
import { RESOURCE_URI_META_KEY } from './mcp-apps.js'
import { TOOL_PROFILES, UNPROFILED_TOOL_PROFILE } from './tool-profiles.js'

// MCP tracer. Calls into the no-op API when tracing is disabled.
const mcpTracer = (): ReturnType<typeof getTracer> => getTracer('whiteboard.mcp')

// The call's own log sink, where its caller may read the server's records.
function forwardedLog<L>(extra: { mcpReq?: { log?: L } } | undefined): L | undefined {
  return callerReadsServerLog() ? extra?.mcpReq?.log : undefined
}

export function structuredJsonResult<T extends object>(result: T) {
  const structuredContent = result as T & { [key: string]: unknown }
  return {
    structuredContent,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
  }
}

// Mirrors the modern `_meta.ui.resourceUri` MCP Apps (SEP-1865) linkage
// into the deprecated `_meta["ui/resourceUri"]` key too, matching what the
// ext-apps package's own registerAppTool does — a host built before
// ui.resourceUri was standardized only reads the legacy key.
function withLegacyResourceUri(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const uiMeta = meta?.ui
  const resourceUri =
    uiMeta !== null && typeof uiMeta === 'object' && 'resourceUri' in uiMeta
      ? (uiMeta as { resourceUri?: unknown }).resourceUri
      : undefined
  return typeof resourceUri === 'string' ? { ...meta, [RESOURCE_URI_META_KEY]: resourceUri } : meta
}

// Binds a registered tool's handler return shape to its declared outputSchema.
// When outputSchema is given, the handler must hand structuredContent whose
// shape matches z.infer<O>; drift becomes a compile error instead of a
// runtime "Output validation error" reaching MCP clients.
export type ToolHandlerReturn<O extends z.ZodTypeAny | undefined> = O extends z.ZodTypeAny
  ?
      | {
          structuredContent: z.infer<O>
          content: CallToolResult['content']
          isError?: false
        }
      | {
          isError: true
          content: CallToolResult['content']
        }
  : {
      content: CallToolResult['content']
      structuredContent?: unknown
      isError?: boolean
    }

// The config the SDK's registerTool takes, read off its first (Standard
// Schema) overload so `_meta`, `annotations` and the rest are the SDK's own
// field types rather than a copy of them. Matching both overloads is what
// selects the first: `Parameters<>` alone reads only the last, deprecated one.
type SdkToolConfig = McpServer['registerTool'] extends {
  (name: string, config: infer C, cb: infer _Cb): unknown
  (...args: infer _Legacy): unknown
}
  ? C
  : never

// A tool's inputSchema is either a raw shape (`{ field: z.string() }`,
// auto-wrapped by the SDK's z.object()) or a whole Zod schema — the latter
// is what keeps a `.strict()` object strict at the boundary, and is the only
// form an input that is a z.discriminatedUnion can take, since a union has
// no raw shape to give. Discriminate on the
// Zod brand first: a raw shape is a plain record with no `_zod`, so it
// never matches the `z.ZodTypeAny` branch.
type InferToolArgs<I> = I extends z.ZodTypeAny
  ? z.infer<I>
  : { [K in keyof I]: I[K] extends z.ZodTypeAny ? z.infer<I[K]> : never }

// Thin wrapper around McpServer.registerTool that injects annotations.
// inputSchema accepts either a raw shape or a whole schema so handler
// argument inference keeps working for both; outputSchema binds the
// handler's return through ToolHandlerReturn<O>.
//
// The handler runs inside its request's log scope (logging.ts), so a record
// it emits is forwarded to this caller and to no other.
//
// It also converts handler throws into MCP `{ isError: true, content: [...] }`
// responses. The MCP spec recommends tool errors use isError responses rather
// than JSON-RPC errors so the LLM can react on the next call.
export function registerToolWithAnnotations<
  I extends z.ZodRawShape | z.ZodTypeAny,
  O extends z.ZodTypeAny | undefined = undefined,
>(
  server: McpServer,
  name: string,
  config: Pick<SdkToolConfig, 'description' | '_meta'> & {
    // Required: the SDK calls a schemaless tool as `(ctx)`, not `(args, ctx)`.
    inputSchema: I
    outputSchema?: O
    // `_meta` carries MCP Apps (SEP-1865) tool linkage, e.g.
    // `{ ui: { resourceUri: 'ui://whiteboard/canvas-view' } }` — see
    // mcp-apps.ts for the resource this links against. A `ui.resourceUri`
    // there is additionally mirrored into the deprecated
    // `["ui/resourceUri"]` key below before reaching server.registerTool.
  },
  handler: (
    args: InferToolArgs<I>,
    extra: ServerContext,
  ) => Promise<ToolHandlerReturn<O>> | ToolHandlerReturn<O>,
): unknown {
  const profile = TOOL_PROFILES[name]
  if (!profile) {
    // Fall back to the destructive profile and emit a warning so it is noticed.
    getLogger('mcp').warning({ name }, 'tool has no annotations profile; announced as destructive')
  }
  const annotations: ToolAnnotations = profile
    ? { ...profile.profile, title: profile.title }
    : { ...UNPROFILED_TOOL_PROFILE, title: name }
  // Wrap the handler so thrown errors become isError responses, and so
  // every tool call is observable as a single MCP-semconv span.
  const tracedHandler = (
    args: InferToolArgs<I>,
    extra: ServerContext,
  ): Promise<ToolHandlerReturn<O>> => {
    // The JSON-RPC id joins this span to the client's own request log. Read
    // defensively: an attribute must never be the reason a tool call fails.
    const rawRequestId = extra?.mcpReq?.id
    const requestId = rawRequestId === undefined ? undefined : String(rawRequestId)
    return mcpTracer().startActiveSpan(
      `mcp.tool.call ${name}`,
      {
        kind: 1, // SpanKind.SERVER (avoid importing the enum here to keep the dispatch path slim)
        attributes: {
          [MCP_ATTR.METHOD_NAME]: 'tools/call',
          [MCP_ATTR.TOOL_NAME]: name,
          ...(requestId === undefined ? {} : { [MCP_ATTR.REQUEST_ID]: requestId }),
        },
      },
      async (span) => {
        try {
          return await runWithRequestLog(forwardedLog(extra), () => handler(args, extra))
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)))
          span.setStatus({
            code: 2, // SpanStatusCode.ERROR — kept inline for the same reason
            message: describeThrown(err),
          })
          throw err
        } finally {
          span.end()
        }
      },
    )
  }
  // Outer error catcher converts thrown errors into MCP isError responses.
  // Kept separate so the span finishes BEFORE we rewrite the throw into a
  // structured response — otherwise the error would still mark the span
  // ERROR but the user would see a "successful" tool call.
  //
  // The SDK parses `args` against `inputSchema` before calling this, but its
  // callback type reads the parsed value through StandardSchemaWithJSON's
  // InferOutput, which cannot see the generic `I` — so the parsed value is
  // re-bound to InferToolArgs<I> here, the one place that relation is known.
  const outerHandler = async (args: unknown, extra: ServerContext): Promise<CallToolResult> => {
    try {
      return await tracedHandler(args as InferToolArgs<I>, extra)
    } catch (err) {
      const message = toolErrorText(name, err)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }],
      }
    }
  }
  const sdkConfig: SdkToolConfig = {
    ...config,
    // A raw shape is the SDK's deprecated overload's form; both overloads
    // share one implementation, which wraps a raw shape in z.object() itself,
    // so only the first overload's declared type is narrower than it accepts.
    inputSchema: config.inputSchema as StandardSchemaWithJSON,
    _meta: withLegacyResourceUri(config._meta),
    annotations,
  }
  return server.registerTool(name, sdkConfig, outerHandler)
}
