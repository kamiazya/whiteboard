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
import { Hono } from 'hono'
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

export function createMcpRouter({
  modernMcpHandler,
  pairingLinkContext,
  pairingUnavailableReason,
}: McpRouterDeps): Hono {
  const router = new Hono()
  router.all('/mcp', async (c) => {
    const startedAt = Date.now()
    const debug = shouldLogMcpHttpDebug()
    let parsedBody: unknown
    if (
      c.req.method.toUpperCase() === 'POST' &&
      c.req.header('content-type')?.toLowerCase().includes('application/json')
    ) {
      try {
        parsedBody = await c.req.raw.clone().json()
      } catch {
        parsedBody = undefined
      }
    }
    if (debug) {
      const initializeDebug = extractInitializeDebugPayload(parsedBody)
      if (initializeDebug) {
        httpLog.info(initializeDebug, 'mcp-http:init')
      }
    }
    // Era routing runs the exact classification `createMcpHandler` itself
    // uses, so this branch can never disagree with the entry. Modern
    // requests never reach the legacy transport below.
    const isLegacy =
      parsedBody !== undefined
        ? await isLegacyRequest(c.req.raw, parsedBody)
        : await isLegacyRequest(c.req.raw)
    if (!isLegacy) {
      const response = await modernMcpHandler.fetch(c.req.raw, { parsedBody })
      if (debug) {
        const body = isJsonObject(parsedBody) ? parsedBody : {}
        httpLog.info(
          {
            httpMethod: c.req.method.toUpperCase(),
            path: c.req.path,
            jsonrpcMethod: body.method ?? null,
            requestId: body.id ?? null,
            status: response.status,
            durationMs: Date.now() - startedAt,
            era: 'modern',
          },
          'mcp-http',
        )
      }
      return response
    }
    // The MCP SDK throws 'Already connected' if a single Server is connected to
    // more than one transport, so build a fresh per-request server. The heavy
    // workspace-id file IO is memoized inside createMcpServer to keep
    // concurrent /mcp requests cheap and race-free.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    let response: Response | undefined
    try {
      const constructStartedAt = debug ? Date.now() : 0
      const server = await createMcpServer({
        pairing: pairingLinkContext,
        pairingUnavailableReason,
      })
      if (debug) {
        httpLog.info({ durationMs: Date.now() - constructStartedAt }, 'mcp-http:construct')
      }
      await server.connect(transport)
      response = await transport.handleRequest(c.req.raw, { parsedBody })
      if (debug) {
        const body = isJsonObject(parsedBody) ? parsedBody : {}
        httpLog.info(
          {
            httpMethod: c.req.method.toUpperCase(),
            path: c.req.path,
            jsonrpcMethod: body.method ?? null,
            requestId: body.id ?? null,
            status: response.status,
            durationMs: Date.now() - startedAt,
          },
          'mcp-http',
        )
      }
      return response
    } finally {
      // Skip transport.close() when the response is an SSE stream
      // (Content-Type: text/event-stream). For SSE the response body is a still
      // open ReadableStream and closing the transport here would cancel it
      // before the client receives any events. JSON-mode responses, by
      // contrast, are fully buffered before handleRequest resolves so close()
      // is safe and useful for cleanup.
      const isSseResponse = response?.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
      if (isSseResponse) {
        if (debug) {
          httpLog.info({ reason: 'sse-stream-active' }, 'mcp-http:destruct-skipped')
        }
      } else {
        const destructStartedAt = debug ? Date.now() : 0
        try {
          await transport.close()
        } catch (error) {
          // Closing failures from a finished request should not leak into the
          // response path. Log only when MCP_HTTP_DEBUG=1 for visibility.
          if (debug) {
            httpLog.info({ message: errorMessage(error) }, 'mcp-http:destruct-error')
          }
        }
        if (debug) {
          httpLog.info({ durationMs: Date.now() - destructStartedAt }, 'mcp-http:destruct')
        }
      }
    }
  })
  return router
}
