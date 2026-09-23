// The `/mcp` endpoint, as a router of its own.
//
// It was 112 lines inside `createApp`, which is the composition root: the
// root's job is to say WHICH adapters exist and in what order, not to be
// one. Its position in the chain is unchanged — it is routed in at exactly
// the line the handler was registered at, after the auth middleware and
// before the other routers.

import {
  type createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server'
import { type Context, Hono } from 'hono'
import { errorMessage } from '../../shared/error-message.js'
import {
  extractInitializeDebugPayload,
  isJsonObject,
  shouldLogMcpHttpDebug,
} from '../app-helpers.js'
import { getLogger } from '../log.js'
import { createMcpServer } from '../mcp/index.js'
import type { PairingLinkContext, PairingUnavailableReason } from '../mcp/pairing-link.js'

/** The same logger name the wiring used, so a record reads the same. */
const httpLog = getLogger('mcp-http')

export interface McpRouterDeps {
  /** The SDK handler  built; this router only routes to it. */
  readonly modernMcpHandler: ReturnType<typeof createMcpHandler>
  readonly pairingLinkContext: PairingLinkContext | undefined
  readonly pairingUnavailableReason: PairingUnavailableReason
}

/**
 * `MCP_HTTP_DEBUG=1`'s tracing, as one object rather than nine `if (debug)`
 * branches through the handler.
 *
 * Every method is a no-op when tracing is off, and each BUILDS its own
 * fields — so the payload extraction and the timestamps cost nothing when
 * nobody is reading them, which is what the inline branches were for. `at()`
 * is `Date.now()`, or 0 when nothing will read the duration.
 */
function mcpHttpTrace(enabled: boolean) {
  return {
    at: (): number => (enabled ? Date.now() : 0),
    init(parsedBody: unknown): void {
      if (!enabled) return
      const payload = extractInitializeDebugPayload(parsedBody)
      if (payload) httpLog.info(payload, 'mcp-http:init')
    },

    exchange(args: {
      c: Context
      parsedBody: unknown
      status: number
      startedAt: number
      era?: 'modern'
    }): void {
      if (!enabled) return
      const body = isJsonObject(args.parsedBody) ? args.parsedBody : {}
      httpLog.info(
        {
          httpMethod: args.c.req.method.toUpperCase(),
          path: args.c.req.path,
          jsonrpcMethod: body.method ?? null,
          requestId: body.id ?? null,
          status: args.status,
          durationMs: Date.now() - args.startedAt,
          ...(args.era === undefined ? {} : { era: args.era }),
        },
        'mcp-http',
      )
    },

    construct(startedAt: number): void {
      if (enabled) httpLog.info({ durationMs: Date.now() - startedAt }, 'mcp-http:construct')
    },

    destructSkipped(): void {
      if (enabled) httpLog.info({ reason: 'sse-stream-active' }, 'mcp-http:destruct-skipped')
    },

    destructError(error: unknown): void {
      if (enabled) httpLog.info({ message: errorMessage(error) }, 'mcp-http:destruct-error')
    },

    destruct(startedAt: number): void {
      if (enabled) httpLog.info({ durationMs: Date.now() - startedAt }, 'mcp-http:destruct')
    },
  }
}

type McpHttpTrace = ReturnType<typeof mcpHttpTrace>

/**
 * The parsed JSON body, or `undefined` for anything that is not a JSON POST.
 *
 * Era routing and both transports read the SAME parse: cloning and parsing
 * twice would be a second chance for the two to disagree about what the
 * request said.
 */
async function jsonBodyOf(c: Context): Promise<unknown> {
  if (c.req.method.toUpperCase() !== 'POST') return undefined
  if (!c.req.header('content-type')?.toLowerCase().includes('application/json')) return undefined
  try {
    return await c.req.raw.clone().json()
  } catch {
    return undefined
  }
}

/**
 * The legacy transport: a FRESH server per request, because the MCP SDK
 * throws 'Already connected' if one Server is connected to more than one
 * transport. The heavy workspace-id file IO is memoized inside
 * `createMcpServer`, so concurrent `/mcp` requests stay cheap and race-free.
 */
async function handleLegacy(
  c: Context,
  deps: McpRouterDeps,
  parsedBody: unknown,
  startedAt: number,
  trace: McpHttpTrace,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  let response: Response | undefined
  try {
    const constructStartedAt = trace.at()
    const server = await createMcpServer({
      pairing: deps.pairingLinkContext,
      pairingUnavailableReason: deps.pairingUnavailableReason,
    })
    trace.construct(constructStartedAt)
    await server.connect(transport)
    response = await transport.handleRequest(c.req.raw, { parsedBody })
    trace.exchange({ c, parsedBody, status: response.status, startedAt })
    return response
  } finally {
    await closeUnlessStreaming(transport, response, trace)
  }
}

/**
 * Closing an SSE response's transport would cancel a body that is still
 * OPEN, before the client received any events — so a `text/event-stream`
 * response is left alone. A JSON-mode response is fully buffered by the time
 * `handleRequest` resolves, so closing there is safe and frees the
 * transport.
 */
async function closeUnlessStreaming(
  transport: WebStandardStreamableHTTPServerTransport,
  response: Response | undefined,
  trace: McpHttpTrace,
): Promise<void> {
  const streaming = response?.headers
    .get('content-type')
    ?.toLowerCase()
    .includes('text/event-stream')
  if (streaming) {
    trace.destructSkipped()
    return
  }
  const destructStartedAt = trace.at()
  try {
    await transport.close()
  } catch (error) {
    // A close failure on a finished request must not leak into the response
    // path; it is visible only under MCP_HTTP_DEBUG=1.
    trace.destructError(error)
  }
  trace.destruct(destructStartedAt)
}

export function createMcpRouter(deps: McpRouterDeps): Hono {
  const router = new Hono()
  router.all('/mcp', async (c) => {
    const startedAt = Date.now()
    const trace = mcpHttpTrace(shouldLogMcpHttpDebug())
    const parsedBody = await jsonBodyOf(c)
    trace.init(parsedBody)

    // Era routing runs the exact classification `createMcpHandler` itself
    // uses, so this branch can never disagree with the entry. Modern
    // requests never reach the legacy transport.
    const legacy =
      parsedBody !== undefined
        ? await isLegacyRequest(c.req.raw, parsedBody)
        : await isLegacyRequest(c.req.raw)
    if (legacy) return handleLegacy(c, deps, parsedBody, startedAt, trace)

    const response = await deps.modernMcpHandler.fetch(c.req.raw, { parsedBody })
    trace.exchange({ c, parsedBody, status: response.status, startedAt, era: 'modern' })
    return response
  })
  return router
}
