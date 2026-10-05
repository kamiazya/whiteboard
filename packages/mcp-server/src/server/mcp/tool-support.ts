import { messageOf } from '@kamiazya/whiteboard-model'
import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { getLogger } from '../log.js'
import { getTracer, MCP_ATTR } from '../observability/tracing.js'
import { RESOURCE_URI_META_KEY } from './mcp-apps.js'
import { TOOL_PROFILES, UNPROFILED_TOOL_PROFILE } from './tool-profiles.js'

// MCP tracer. Calls into the no-op API when tracing is disabled.
const mcpTracer = (): ReturnType<typeof getTracer> => getTracer('whiteboard.mcp')

export function structuredJsonResult<T extends object>(result: T) {
  const structuredContent = result as T & { [key: string]: unknown }
  return {
    structuredContent,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
  }
}

// Binds a registered tool's handler return shape to its declared outputSchema.
// When outputSchema is given, the handler must hand structuredContent whose
// shape matches z.infer<O>; drift becomes a compile error instead of a
// runtime "Output validation error" reaching MCP clients.
export type ToolHandlerReturn<O extends z.ZodTypeAny | undefined> = O extends z.ZodTypeAny
  ?
      | {
          structuredContent: z.infer<O>
          content: ReadonlyArray<{ type: 'text'; text: string } | Record<string, unknown>>
          isError?: false
        }
      | {
          isError: true
          content: ReadonlyArray<{ type: 'text'; text: string } | Record<string, unknown>>
        }
  : {
      content: ReadonlyArray<{ type: 'text'; text: string } | Record<string, unknown>>
      structuredContent?: unknown
      isError?: boolean
    }

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
// argument inference keeps working for both; outputSchema stays unknown
// because the SDK accepts multiple overload shapes.
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
  config: {
    description?: string
    inputSchema?: I
    outputSchema?: O
    // MCP Apps (SEP-1865) tool-linkage metadata, e.g.
    // `{ ui: { resourceUri: 'ui://whiteboard/canvas-view' } }` — see
    // mcp-apps.ts for the resource this links against. A `ui.resourceUri`
    // here is additionally mirrored into the deprecated
    // `["ui/resourceUri"]` key below before reaching server.registerTool.
    _meta?: Record<string, unknown>
  },
  handler: (
    args: InferToolArgs<I>,
    extra: Parameters<Parameters<McpServer['registerTool']>[2]>[1],
  ) => Promise<ToolHandlerReturn<O>> | ToolHandlerReturn<O>,
): unknown {
  const profile = TOOL_PROFILES[name]
  if (!profile) {
    // Fall back to the destructive profile and emit a warning so it is noticed.
    getLogger('mcp').warning({ name }, 'tool has no annotations profile; announced as destructive')
  }
  const annotations = profile
    ? { ...profile.profile, title: profile.title }
    : { ...UNPROFILED_TOOL_PROFILE, title: name }
  // Mirror the modern `_meta.ui.resourceUri` MCP Apps (SEP-1865) linkage
  // into the deprecated `_meta["ui/resourceUri"]` key too, matching what
  // the ext-apps package's own registerAppTool does — a host built before
  // ui.resourceUri was standardized only reads the legacy key.
  const uiMeta = config._meta?.ui
  const resourceUri =
    uiMeta !== null && typeof uiMeta === 'object' && 'resourceUri' in uiMeta
      ? (uiMeta as { resourceUri?: unknown }).resourceUri
      : undefined
  const meta =
    typeof resourceUri === 'string'
      ? { ...config._meta, [RESOURCE_URI_META_KEY]: resourceUri }
      : config._meta
  // Wrap the handler so thrown errors become isError responses, and so
  // every tool call is observable as a single MCP-semconv span.
  const tracedHandler = async (
    args: InferToolArgs<I>,
    extra: Parameters<typeof handler>[1],
  ): Promise<unknown> => {
    const rawRequestId = (extra as { requestId?: unknown })?.requestId
    const requestId =
      typeof rawRequestId === 'string' || typeof rawRequestId === 'number'
        ? String(rawRequestId)
        : undefined
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
          return await handler(args, extra)
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)))
          span.setStatus({
            code: 2, // SpanStatusCode.ERROR — kept inline for the same reason
            message: messageOf(err, String(err)),
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
  const outerHandler = async (
    args: InferToolArgs<I>,
    extra: Parameters<typeof handler>[1],
  ): Promise<unknown> => {
    try {
      return await tracedHandler(args, extra)
    } catch (err) {
      const message = messageOf(err, String(err))
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }],
      }
    }
  }
  return (
    server.registerTool as unknown as (n: string, c: object, h: typeof outerHandler) => unknown
  )(name, { ...config, _meta: meta, annotations }, outerHandler)
}
