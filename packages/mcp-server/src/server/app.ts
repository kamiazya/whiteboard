import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { decodeFrontiers, encodeFrontiers, LoroDoc } from 'loro-crdt'
import type { RuntimeStatusResponse } from '../shared/api-contracts/runtime.js'
import { detectMergeBadges } from '../shared/merge-engine.js'
import { reconcileElementsOnDoc } from '../shared/reconcile-elements.js'
import { DIST_WEB_APP_DIR } from './config.js'
import { getLogger, getLogLevel, setLogLevel } from './log.js'
import { createExcalidrawMcpServer } from './mcp/index.js'
import { tracingMiddleware } from './observability/http-tracing.js'
import { createDaemonAuthMiddleware } from './routes/auth.js'
import { createBranchesRouter } from './routes/branches.js'
import { createCanvasRouter } from './routes/canvas.js'
import { createDebugRouter } from './routes/debug.js'
import { createExportRouter, resolveExportRequest } from './routes/export.js'
import { createFilesRouter } from './routes/files.js'
import { createLibrariesRouter } from './routes/libraries.js'
import { createPaletteRouter } from './routes/palette.js'
import { createRuntimeRouter } from './routes/runtime.js'
import { createStatusRouter } from './routes/status.js'
import { createViewportRouter, resolveViewportRequest } from './routes/viewport.js'
import {
  broadcastLoroUpdate,
  sendHeadChanged,
  setResolveExportFn,
  setResolveViewportFn,
} from './routes/ws.js'
import { createApiHostGuardMiddleware } from './security/api-host-guard.js'
import type { AuthScope } from './security/auth-strategy.js'
import { createApiLoopbackCorsMiddleware } from './security/cors-loopback.js'
import {
  buildMcpProtectedResourceMetadata,
  createLocalTokenMcpHttpAuthStrategy,
  type McpHttpAuthStrategy,
} from './security/mcp-auth.js'
import { createMcpHttpAuthMiddleware, createMcpHttpOriginMiddleware } from './security/mcp-http.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import { matchOrigin, parseOriginPatterns } from './security/origin-pattern.js'
import { resolveApiRouteScope } from './security/route-scope-registry.js'
import { planServerModeAuth } from './security/server-mode-auth-plan.js'
import {
  BranchNotFoundError,
  deleteBranch,
  loadCanvasBranches,
  setHead as setHeadPersist,
  updateBranchTip,
} from './store/branches-store.js'
import { canvasExists, saveCanvas } from './store/canvas-store.js'
import { corruptStoredData, isCorruptStoredDataError } from './store/corrupt-stored-data.js'
import { getDoc, peekDoc } from './store/doc-cache.js'
import { FileVersionStore } from './store/version-store.js'

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

function shouldLogMcpHttpDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_HTTP_DEBUG === '1'
}

const httpLog = getLogger('mcp-http')

// MCP_HTTP_DEBUG=1 historically meant "show http traces unconditionally". Keep
// that contract: bump the logger threshold down to info so the structured
// records below land on stderr / `notifications/message` even when the
// operator has not set WHITEBOARD_LOG_LEVEL=info. The previous gate only
// fired when the level was *exactly* `warning`; any stricter level
// (`notice`, `error`, `critical`, …) silently dropped every httpLog.info
// record below, defeating the whole point of the env switch.
if (shouldLogMcpHttpDebug()) {
  const currentLogLevel = getLogLevel()
  if (currentLogLevel !== 'debug' && currentLogLevel !== 'info') {
    setLogLevel('info')
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setBaselineSecurityHeaders(headers: Headers): void {
  headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
}

// Serialize a value for inlining into a `<script>` body, escaping `<` so a
// value such as `</script>` cannot terminate the tag and inject markup. Tokens
// today are nanoid-generated (safe), but this keeps the path safe if
// user-controlled values are ever inlined here.
// https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
function toInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

// Paths reserved for /api, /mcp, /ws, and .well-known routes must never
// fall through to the SPA catch-all: an unmatched request under one of
// these prefixes means "route not found", not "serve index.html".
function isReservedUiPath(path: string): boolean {
  return (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path === '/ws' ||
    path.startsWith('/ws/') ||
    path.startsWith('/.well-known/')
  )
}

// Minimal, honest placeholder served at server-mode's root. Server-mode has
// its own OAuth/JWT auth (see AsyncAuthStrategy) and no local-daemon bearer
// token; apps/web's provider model only knows browser-local and
// local-daemon-token auth, so injecting it here without a real token would
// serve a UI whose every request 401s. Point operators at the API/MCP
// surface instead until apps/web grows a server-mode-aware auth flow.
const SERVER_MODE_PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Whiteboard (server mode)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<h1>Whiteboard server</h1>
<p>This daemon is running in server mode, which does not serve the browser UI.</p>
<p>Use the HTTP API under <code>/api</code> or connect an MCP client to <code>/mcp</code>.</p>
</body>
</html>
`

function extractInitializeDebugPayload(parsedBody: unknown) {
  if (!isJsonObject(parsedBody) || parsedBody.method !== 'initialize') {
    return null
  }
  const params = isJsonObject(parsedBody.params) ? parsedBody.params : {}
  const capabilities = isJsonObject(params.capabilities) ? params.capabilities : {}
  const clientInfo = isJsonObject(params.clientInfo) ? params.clientInfo : {}
  return {
    requestId: parsedBody.id ?? null,
    protocolVersion: params.protocolVersion ?? null,
    clientInfo: {
      name: clientInfo.name ?? null,
      version: clientInfo.version ?? null,
    },
    capabilities,
  }
}

function decodeBranchTipOrThrow(
  workspaceId: string,
  slug: string,
  branchName: string,
  tipFrontiersBase64: string,
) {
  try {
    return decodeFrontiers(new Uint8Array(Buffer.from(tipFrontiersBase64, 'base64')))
  } catch (error) {
    throw corruptStoredData(
      `${workspaceId}/branches/${slug}.json#${branchName}.tipFrontiers`,
      `tipFrontiers could not be decoded (${errorMessage(error)})`,
    )
  }
}

function checkoutCloneOrThrow(
  doc: LoroDoc,
  target: ReturnType<typeof decodeFrontiers>,
  location: string,
  detail: string,
): LoroDoc {
  const clone = LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }))
  try {
    clone.checkout(target)
  } catch (error) {
    throw corruptStoredData(location, `${detail} (${errorMessage(error)})`)
  }
  return clone
}

export interface LocalDaemonAppOptions {
  authMode: 'local-daemon'
  token?: string
  mcpAuth?: McpHttpAuthStrategy
  /** Per-process-start identifier for /api/runtime/ping. Falls back to a
   *  fresh crypto.randomUUID() when omitted (tests, ad-hoc callers). */
  instanceId?: string
  touch: () => void
  getStatus: () => RuntimeStatusResponse
  shutdown: () => Promise<void>
  /** Exact-match hosted origins admitted alongside the fixed loopback set
   *  (WHITEBOARD_ALLOWED_WEB_ORIGINS). Empty by default — current loopback-only
   *  behavior is unchanged unless an operator opts in. Local-daemon only;
   *  server-mode governs its origins solely via allowedOrigins below. */
  allowedWebOrigins?: readonly string[]
}

export interface ServerModeAppOptions {
  authMode: 'server-mode'
  publicBaseUrl: string
  allowedOrigins: readonly string[]
  authStrategy: AsyncAuthStrategy
  /** Per-process-start identifier for /api/runtime/ping. Falls back to a
   *  fresh crypto.randomUUID() when omitted (tests, ad-hoc callers). */
  instanceId?: string
  touch: () => void
  getStatus: () => RuntimeStatusResponse
  shutdown: () => Promise<void>
}

export type AppOptions = LocalDaemonAppOptions | ServerModeAppOptions

function buildServerModeAuthFailResponse(decision: {
  status: 401 | 403
  code: string
  wwwAuthenticate?: string
}): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (decision.status === 401 && decision.wwwAuthenticate) {
    headers.set('WWW-Authenticate', decision.wwwAuthenticate)
  }
  return new Response(JSON.stringify({ error: decision.code }), {
    status: decision.status,
    headers,
  })
}

function createServerModeApiAuthMiddleware(authStrategy: AsyncAuthStrategy): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    const routeScope = resolveApiRouteScope(method, c.req.path)
    // No declared decision at all: fail closed rather than silently applying
    // a guessed scope. Reaching this branch means a route was mounted under
    // /api/* without an entry in route-scope-registry.ts — the registry-wide
    // test (route-scope-registry.test.ts) is meant to catch this before it
    // ships, so a live 500 here means that guard was bypassed or the route
    // was added after the registry without updating both.
    if (routeScope === null) {
      return c.json({ error: 'auth.route-undeclared' }, 500)
    }
    // The `public` decision is a deliberate, documented carve-out (currently
    // only GET /api/runtime/ping — a liveness probe) — never an omission.
    if (routeScope.kind === 'public') return next()
    const decision = await authStrategy.authorize({
      method,
      path: c.req.path,
      authorizationHeader: c.req.header('authorization'),
      requiredScopes: routeScope.scopes,
    })
    if (decision.ok) return next()
    return buildServerModeAuthFailResponse(decision)
  }
}

function createServerModeAsyncAuthMiddleware(
  authStrategy: AsyncAuthStrategy,
  requiredScopes: readonly AuthScope[],
): MiddlewareHandler {
  return async (c, next) => {
    const decision = await authStrategy.authorize({
      method: c.req.method,
      path: c.req.path,
      authorizationHeader: c.req.header('authorization'),
      requiredScopes,
    })
    if (decision.ok) return next()
    return buildServerModeAuthFailResponse(decision)
  }
}

// Pattern-aware: allowedOrigins may contain exact origins or leftmost-label
// wildcard subdomain patterns (see origin-pattern.ts). Deliberately does NOT
// build a Set of `new URL(o).origin` strings for exact-match lookup — that
// call does not throw on a wildcard entry (it parses '*' as a literal
// hostname character), so an exact-Set lookup would silently never admit a
// real subdomain rather than fail loudly.
function createServerModeOriginMiddleware(allowedOrigins: readonly string[]): MiddlewareHandler {
  const patterns = parseOriginPatterns(allowedOrigins)
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (!origin) {
      if (c.req.method.toUpperCase() === 'OPTIONS') return new Response(null, { status: 204 })
      return next()
    }
    if (!matchOrigin(patterns, origin)) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'forbidden origin' }, id: null },
        { status: 403 },
      )
    }
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    )
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    c.res.headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    c.res.headers.set('Access-Control-Max-Age', '86400')
    if (c.req.method.toUpperCase() === 'OPTIONS') {
      return new Response(null, { status: 204, headers: c.res.headers })
    }
    await next()
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    )
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    c.res.headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    c.res.headers.set('Access-Control-Max-Age', '86400')
  }
}

function sanitizeServerModeStatus(
  getStatus: () => RuntimeStatusResponse,
  publicBaseUrl: string,
): () => RuntimeStatusResponse {
  const parsedUrl = new URL(publicBaseUrl)
  const derivedPort = parsedUrl.port
    ? parseInt(parsedUrl.port, 10)
    : parsedUrl.protocol === 'https:'
      ? 443
      : 80
  return () => {
    const raw = getStatus()
    return {
      ...raw,
      host: '[server-managed]',
      port: derivedPort,
      baseUrl: publicBaseUrl,
      storage: { ...raw.storage, dataDir: '[server-managed]' },
      mcp: { ...raw.mcp, endpoint: `${publicBaseUrl}/mcp` },
    }
  }
}

setResolveExportFn(resolveExportRequest)
setResolveViewportFn(resolveViewportRequest)

export function createApp(options: AppOptions) {
  if (options.authMode === 'local-daemon' && 'authStrategy' in options) {
    throw new Error('local-daemon mode must not receive authStrategy')
  }

  const app = new Hono()

  const instanceId = options.instanceId ?? randomUUID()
  const token = options.authMode === 'local-daemon' ? options.token : undefined
  const mcpAuth =
    options.authMode === 'local-daemon'
      ? (options.mcpAuth ?? createLocalTokenMcpHttpAuthStrategy({ token: options.token }))
      : undefined

  let serverModeGetStatus: (() => RuntimeStatusResponse) | undefined
  if (options.authMode === 'server-mode') {
    const plan = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: options.publicBaseUrl,
      allowedOrigins: [...options.allowedOrigins],
    })
    if (!plan.ok) throw new Error('invalid server-mode config')
    serverModeGetStatus = sanitizeServerModeStatus(options.getStatus, options.publicBaseUrl)
  }

  // Tracing middleware first so the request span wraps every other
  // middleware (auth, headers, route handler). When OTel is disabled the
  // tracer is a no-op so the wrapping cost is negligible.
  app.use('*', tracingMiddleware())

  // Tracing middleware first so the request span wraps every other
  // middleware (auth, headers, route handler). When OTel is disabled the
  // tracer is a no-op so the wrapping cost is negligible.
  app.use('*', tracingMiddleware())

  app.use('*', async (_c, next) => {
    options.touch()
    await next()
  })

  app.use('*', async (c, next) => {
    await next()
    setBaselineSecurityHeaders(c.res.headers)
  })

  if (options.authMode === 'server-mode') {
    app.use('/api/*', createApiHostGuardMiddleware(options.authMode))
    app.use('/api/*', createServerModeApiAuthMiddleware(options.authStrategy))
  } else {
    // Host guard runs first, ahead of CORS, so a spoofed non-loopback Host
    // (DNS rebinding) is rejected before the OPTIONS short-circuit below can
    // hand out a 204 — otherwise a preflight would bypass the guard entirely.
    app.use('/api/*', createApiHostGuardMiddleware(options.authMode))
    // In local-daemon mode, allow cross-origin loopback requests (e.g. apps/web
    // dev server on localhost:5173 → daemon on 127.0.0.1:3099).
    // The CORS middleware is applied BEFORE the auth guard so that
    // OPTIONS preflights short-circuit to 204 without needing a bearer token,
    // while every other method (GET included — see auth.js) falls through to
    // the auth chain unchanged.
    app.use('/api/*', createApiLoopbackCorsMiddleware(options.allowedWebOrigins ?? []))
    app.use('/api/*', createDaemonAuthMiddleware(token))
  }

  if (mcpAuth) {
    app.get('/.well-known/oauth-protected-resource', (c) => {
      const metadata = buildMcpProtectedResourceMetadata(mcpAuth, c.req.url)
      if (!metadata) return c.notFound()
      return c.json(metadata)
    })
    app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
      const metadata = buildMcpProtectedResourceMetadata(mcpAuth, c.req.url)
      if (!metadata) return c.notFound()
      return c.json(metadata)
    })
  }

  // /mcp middleware:
  // - origin policy: server-mode checks allowedOrigins; local-daemon allows loopback only
  // - auth: server-mode uses AsyncAuthStrategy with mcp:call scope; local-daemon uses daemon token
  // - bodyLimit: prevent OOM from oversized JSON-RPC payloads (4 MiB)
  if (options.authMode === 'server-mode') {
    const serverModePlan = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: options.publicBaseUrl,
      allowedOrigins: [...options.allowedOrigins],
    })
    if (serverModePlan.ok && serverModePlan.kind === 'server-mode') {
      app.use('/mcp', createServerModeOriginMiddleware(serverModePlan.allowedOrigins))
    }
    app.use('/mcp', createServerModeAsyncAuthMiddleware(options.authStrategy, ['mcp:call']))
  } else {
    app.use('/mcp', createMcpHttpOriginMiddleware(options.allowedWebOrigins ?? []))
    app.use('/mcp', createMcpHttpAuthMiddleware(mcpAuth!))
  }
  app.use(
    '/mcp',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            jsonrpc: '2.0',
            error: { code: -32600, message: 'Request body too large (max 4 MiB)' },
            id: null,
          },
          413,
        ),
    }),
  )

  app.all('/mcp', async (c) => {
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
    // The MCP SDK throws 'Already connected' if a single Server is connected to
    // more than one transport, so build a fresh per-request server. The heavy
    // workspace-id file IO is memoized inside createExcalidrawMcpServer to keep
    // concurrent /mcp requests cheap and race-free.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    let response: Response | undefined
    try {
      const constructStartedAt = debug ? Date.now() : 0
      const server = await createExcalidrawMcpServer()
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

  app.route(
    '/',
    createCanvasRouter({
      // Attach the current HEAD branch name to saved versions when available.
      getHeadBranch: async (sid, slug) => {
        try {
          const state = await loadCanvasBranches(sid, slug)
          return state.head
        } catch (error) {
          if (isCorruptStoredDataError(error)) {
            throw error
          }
          return null
        }
      },
    }),
  )
  // Shared versionStore so the files router can do version-aware purge
  // and the branches router can resolve frontiers — they would each
  // instantiate their own otherwise.
  const sharedVersionStore = new FileVersionStore()
  app.route('/', createFilesRouter({ versionStore: sharedVersionStore }))
  app.route('/', createExportRouter())
  app.route('/', createViewportRouter())
  app.route('/', createDebugRouter({ token }))
  app.route('/', createStatusRouter())
  app.route('/', createLibrariesRouter())
  app.route('/', createPaletteRouter())
  app.route(
    '/',
    createRuntimeRouter({
      token,
      mcpAuth: mcpAuth ?? undefined,
      instanceId,
      touch: options.touch,
      getStatus: options.authMode === 'server-mode' ? serverModeGetStatus! : options.getStatus,
      shutdown: options.shutdown,
    }),
  )
  // Branches router: branch metadata plus checkout / broadcast integration.
  {
    const versionStore = sharedVersionStore
    app.route(
      '/',
      createBranchesRouter({
        // Resolve fromVersionId to its saved frontiers (base64).
        resolveFromVersionFrontiers: (sid, vid) => versionStore.getFrontiersBase64(sid, vid),
        // Return the live document frontiers as base64 so the previous HEAD can keep
        // its current position before a branch switch.
        getCurrentFrontiers: async (sid, slug) => {
          const cached = peekDoc(sid, slug)
          if (!cached && !(await canvasExists(sid, slug))) {
            return null
          }
          const doc = cached ?? (await getDoc(sid, slug))
          const bytes = encodeFrontiers(doc.frontiers())
          return Buffer.from(bytes).toString('base64')
        },
        // Reconcile the live document to the new HEAD tipFrontiers, then commit, save, and broadcast.
        checkoutTo: async (sid, slug, tipFrontiersBase64) => {
          const doc = await getDoc(sid, slug)
          const targetFrontiers = decodeBranchTipOrThrow(
            sid,
            slug,
            'checkout-target',
            tipFrontiersBase64,
          )
          const clone = checkoutCloneOrThrow(
            doc,
            targetFrontiers,
            `${sid}/branches/${slug}.json#checkout-target.tipFrontiers`,
            'tipFrontiers could not be checked out against the live document',
          )
          const prevVV = doc.version()
          reconcileElementsOnDoc(doc, clone)
          doc.commit()
          await saveCanvas(sid, slug, doc, { overwrite: true })
          const update = doc.export({ mode: 'update', from: prevVV }) as Uint8Array
          if (update.byteLength > 0) {
            broadcastLoroUpdate(sid, slug, update)
          }
        },
        // Notify all peers when the HEAD switch is complete.
        notifyHeadChanged: (sid, slug, head) => sendHeadChanged(sid, slug, head),
        // Keep version metadata branchName values in sync during branch rename.
        renameInVersions: (sid, slug, oldName, newName) =>
          versionStore.renameBranchInVersions(sid, slug, oldName, newName),
        // Count the actual unmerged commits returned by DELETE /branches/:name.
        countVersionsOnBranch: async (sid, slug, branchName) => {
          const list = await versionStore.list(sid, slug)
          return list.filter((v) => (v.branchName ?? 'main') === branchName).length
        },
        // Merge source into target.
        // (1) clone the live snapshot
        // (2) build a preview checked out to the target tipFrontiers
        // (3) detect LWW edge cases with detectMergeBadges
        // (4) on commit, update target tipFrontiers to source and, if target is HEAD,
        //     reconcile the live doc to the preview and broadcast the change
        performMerge: async (sid, slug, { source, into, dryRun }) => {
          const state = await loadCanvasBranches(sid, slug)
          const sourceBranch = state.branches.find((b) => b.name === source)
          const intoBranch = state.branches.find((b) => b.name === into)
          if (!sourceBranch) {
            throw new BranchNotFoundError(`Branch "${source}" not found on ${sid}/${slug}`)
          }
          if (!intoBranch) {
            throw new BranchNotFoundError(`Branch "${into}" not found on ${sid}/${slug}`)
          }

          const sourceTip = sourceBranch.tipFrontiers
          const intoTip = intoBranch.tipFrontiers
          const liveDoc = await getDoc(sid, slug)

          const cloneAt = (branchName: string, tipBase64: string): LoroDoc => {
            if (tipBase64.length === 0) {
              return LoroDoc.fromSnapshot(liveDoc.export({ mode: 'snapshot' }))
            }
            const frontiers = decodeBranchTipOrThrow(sid, slug, branchName, tipBase64)
            return checkoutCloneOrThrow(
              liveDoc,
              frontiers,
              `${sid}/branches/${slug}.json#${branchName}.tipFrontiers`,
              `branch "${branchName}" tipFrontiers could not be checked out against the live document`,
            )
          }

          const targetDoc = cloneAt(into, intoTip ?? '')
          const sourceDoc = cloneAt(source, sourceTip ?? '')
          // Use sourceDoc as the preview representation. Building a fully merged preview
          // safely would require a snapshot containing the full op-log after combining
          // target and source frontiers. In practice, sourceDoc closely matches the merge
          // result for the current "source wins" flow, and detectMergeBadges only needs a
          // stable target/source/preview triple to surface LWW differences.
          const previewDoc = sourceDoc
          const badges = detectMergeBadges({
            target: targetDoc,
            source: sourceDoc,
            preview: previewDoc,
          })

          const countAlive = (doc: LoroDoc): number => {
            try {
              const list = doc.getMovableList('elements').toJSON() as Array<{
                isDeleted?: boolean
              }>
              return list.filter((e) => !e.isDeleted).length
            } catch {
              return 0
            }
          }
          const previewElementCount = countAlive(previewDoc)
          const targetElementCount = countAlive(targetDoc)
          const sourceElementCount = countAlive(sourceDoc)

          // Diff alive elements between target and preview so the UI can highlight
          // new / changed / conflict elements after commit.
          const aliveMap = (doc: LoroDoc): Map<string, Record<string, unknown>> => {
            try {
              const list = doc.getMovableList('elements').toJSON() as Array<
                Record<string, unknown> & { id?: unknown; isDeleted?: unknown }
              >
              const out = new Map<string, Record<string, unknown>>()
              for (const el of list) {
                if (el.isDeleted) continue
                if (typeof el.id !== 'string') continue
                out.set(el.id, el)
              }
              return out
            } catch {
              return new Map()
            }
          }
          const tMap = aliveMap(targetDoc)
          const pMap = aliveMap(previewDoc)
          const newElementIds: string[] = []
          const changedElementIds: string[] = []
          for (const [id, pEl] of pMap) {
            const tEl = tMap.get(id)
            if (!tEl) {
              newElementIds.push(id)
            } else if (JSON.stringify(pEl) !== JSON.stringify(tEl)) {
              changedElementIds.push(id)
            }
          }
          const conflictElementIds = Array.from(
            new Set(
              (badges as Array<Record<string, unknown>>)
                .map((b) => (typeof b.elementId === 'string' ? b.elementId : ''))
                .filter((v) => v.length > 0),
            ),
          )

          if (dryRun) {
            // For dry runs, return only alive elements so MergeDialog can render a
            // read-only Excalidraw preview without duplicating tombstoned elements.
            const previewElements = (() => {
              try {
                const list = previewDoc.getMovableList('elements').toJSON() as Array<{
                  isDeleted?: boolean
                }>
                return list.filter((e) => !e.isDeleted)
              } catch {
                return []
              }
            })()
            return {
              previewElementCount,
              targetElementCount,
              sourceElementCount,
              badges,
              committed: false,
              previewElements,
            }
          }

          // Capture a "before merge" version so the UI can offer undo by restoring it.
          // This is most useful when HEAD points at the target, but saving it uniformly
          // keeps the UI behavior consistent.
          let preMergeVersionId: string | undefined
          try {
            const beforeVersion = await versionStore.save(sid, slug, liveDoc, {
              auto: true,
              label: `before merge: ${source} → ${into}`,
              branchName: into,
              operator: {
                kind: 'system',
                peerId: liveDoc.peerIdStr,
                displayName: 'merge',
              },
            })
            preMergeVersionId = beforeVersion.id
          } catch (err) {
            // Snapshot failure should not block the merge itself.
            getLogger('merge').warning(
              { workspaceId: sid, slug, err: err as Error },
              'pre-merge snapshot failed',
            )
          }

          // Commit by moving the target tipFrontiers to the source tip, unless the source
          // branch is still uninitialized.
          if (typeof sourceTip === 'string' && sourceTip.length > 0) {
            await updateBranchTip(sid, slug, into, sourceTip)
          }

          // If the target is HEAD, reconcile and broadcast the live doc. Otherwise only
          // rewrite the stored tip.
          const latest = await loadCanvasBranches(sid, slug)
          if (latest.head === into && sourceTip && sourceTip.length > 0) {
            const prevVV = liveDoc.version()
            reconcileElementsOnDoc(liveDoc, previewDoc)
            liveDoc.commit()
            await saveCanvas(sid, slug, liveDoc, { overwrite: true })
            const update = liveDoc.export({ mode: 'update', from: prevVV }) as Uint8Array
            if (update.byteLength > 0) {
              broadcastLoroUpdate(sid, slug, update)
            }
            sendHeadChanged(sid, slug, into)
          }

          // Post-merge cleanup:
          // 1) if HEAD still points at source, move it to target so the user sees the result
          // 2) delete the source branch unless it is main or the same as target
          // Cleanup failures only produce warnings; the merge still succeeds.
          let switchedHead: { from: string; to: string } | undefined
          let deletedSource: string | undefined
          try {
            const afterCommit = await loadCanvasBranches(sid, slug)
            if (afterCommit.head === source && source !== into) {
              await setHeadPersist(sid, slug, into)
              switchedHead = { from: source, to: into }
              sendHeadChanged(sid, slug, into)
              // Reconcile and broadcast the live doc to match the target preview.
              // This is already done when HEAD===target, but HEAD===source needs it here.
              const prevVV = liveDoc.version()
              reconcileElementsOnDoc(liveDoc, previewDoc)
              liveDoc.commit()
              await saveCanvas(sid, slug, liveDoc, { overwrite: true })
              const update = liveDoc.export({ mode: 'update', from: prevVV }) as Uint8Array
              if (update.byteLength > 0) {
                broadcastLoroUpdate(sid, slug, update)
              }
            }
          } catch (err) {
            getLogger('merge').warning(
              { workspaceId: sid, slug, err: err as Error },
              'post-merge head switch failed',
            )
          }
          if (source !== 'main' && source !== into) {
            try {
              await deleteBranch(sid, slug, source)
              deletedSource = source
            } catch (err) {
              // For example: still HEAD, already deleted, and similar cleanup races.
              getLogger('merge').warning(
                { workspaceId: sid, slug, err: err as Error },
                'post-merge delete source failed',
              )
            }
          }

          return {
            previewElementCount,
            targetElementCount,
            sourceElementCount,
            badges,
            committed: true,
            newElementIds,
            changedElementIds,
            conflictElementIds,
            preMergeVersionId,
            switchedHead,
            deletedSource,
          }
        },
      }),
    )
  }

  if (options.authMode === 'server-mode') {
    // Server-mode serves only the static placeholder above — no build
    // artifact, no runtime-config / token injection, no static asset roots.
    app.get('*', (c) => {
      if (isReservedUiPath(c.req.path)) {
        return c.notFound()
      }
      return c.html(SERVER_MODE_PLACEHOLDER_HTML)
    })
    return app
  }

  for (const pattern of ['/fonts/*', '/assets/*']) {
    app.use(pattern, serveStatic({ root: DIST_WEB_APP_DIR }))
  }

  // Captured once here, not read from getStatus() inside the request handler
  // below: the port is fixed for the app instance's lifetime, but getStatus()
  // also computes app.buildPresent via a synchronous existsSync() (see
  // http-server.ts) that must run fresh per real status check, not on every
  // SPA page load.
  const daemonPort = options.getStatus().port

  app.get('*', async (c) => {
    if (isReservedUiPath(c.req.path)) {
      return c.notFound()
    }
    try {
      const html = await readFile(join(DIST_WEB_APP_DIR, 'index.html'), 'utf-8')
      // The daemon token is deliberately NOT part of __WHITEBOARD_RUNTIME_CONFIG__
      // (see shared/token-store.ts) — it ships in its own global so it never
      // rides along inside an object that logging / error-reporting could
      // serialize wholesale.
      const runtimeConfigJson = toInlineScriptJson({
        // Composed from 127.0.0.1 + port (not getStatus().baseUrl) so the
        // value is always a loopback origin, even when the daemon binds 0.0.0.0.
        daemonBaseUrl: `http://127.0.0.1:${daemonPort}`,
      })
      const runtimeConfigScript = `<script>window.__WHITEBOARD_RUNTIME_CONFIG__ = ${runtimeConfigJson}</script>`
      const tokenScript = token
        ? `<script>window.__WHITEBOARD_DAEMON_TOKEN__ = ${toInlineScriptJson(token)}</script>`
        : ''
      const injected = `${runtimeConfigScript}${tokenScript}`
      const withRuntimeConfig = html.includes('</head>')
        ? html.replace('</head>', `${injected}</head>`)
        : `${injected}${html}`
      return c.html(withRuntimeConfig)
    } catch {
      return c.text('Not found. Run `pnpm build` first.', 404)
    }
  })

  return app
}
