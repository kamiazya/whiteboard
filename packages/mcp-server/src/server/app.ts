import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { createServer as createOpenCanvasServer } from '@kamiazya/whiteboard-server-core'
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { PeerID } from 'loro-crdt'
import { encodeFrontiers, LoroDoc, VersionVector } from 'loro-crdt'
import type { RuntimeStatusResponse } from '../shared/api-contracts/runtime.js'
import { detectMergeBadges, toElementMap } from '../shared/merge-engine.js'
import {
  checkoutCloneOrThrow,
  decodeBranchTipOrThrow,
  errorMessage,
  extractInitializeDebugPayload,
  isJsonObject,
  isReservedUiPath,
  SERVER_MODE_PLACEHOLDER_HTML,
  setBaselineSecurityHeaders,
  shouldLogMcpHttpDebug,
  toInlineScriptJson,
} from './app-helpers.js'
import type { AppOptions } from './app-types.js'
import { DIST_WEB_APP_DIR, getDataDir } from './config.js'
import { getLogger, getLogLevel, setLogLevel } from './log.js'
import { createMcpServer } from './mcp/index.js'
import { tracingMiddleware } from './observability/http-tracing.js'
import { createCspNonce, pairPageCsp } from './pair-page-csp.js'
import { createDaemonAuthMiddleware } from './routes/auth.js'
import { createBranchesRouter } from './routes/branches.js'
import { createCanvasRouter } from './routes/canvas.js'
import { createDebugRouter } from './routes/debug.js'
import { createExportRouter } from './routes/export.js'
import { createFilesRouter } from './routes/files.js'
import {
  createOAuthAuthzRouter,
  OAUTH_AUTHZ_CORS_PATHS,
  OAUTH_AUTHZ_PATHS,
} from './routes/oauth-authz.js'
import { createPairingRouter } from './routes/pairing.js'
import { createRuntimeRouter } from './routes/runtime.js'
import { createStatusRouter } from './routes/status.js'
import { createSyncSseRouter } from './routes/sync-sse.js'
import { createViewportRouter, resolveViewportRequest } from './routes/viewport.js'
import { broadcastLoroUpdate, sendHeadChanged, setResolveViewportFn } from './routes/ws.js'
import { createWsTicketRouter } from './routes/ws-ticket.js'
import { createApiHostGuardMiddleware } from './security/api-host-guard.js'
import { createApiLoopbackCorsMiddleware } from './security/cors-loopback.js'
import { createDaemonIdentity } from './security/daemon-identity.js'
import {
  buildMcpProtectedResourceMetadata,
  createLocalTokenMcpHttpAuthStrategy,
} from './security/mcp-auth.js'
import { createMcpHttpAuthMiddleware, createMcpHttpOriginMiddleware } from './security/mcp-http.js'
import { createOAuthTransactionStore } from './security/oauth-authz-transactions.js'
import { planServerModeAuth } from './security/server-mode-auth-plan.js'
import {
  createServerModeApiAuthMiddleware,
  createServerModeAsyncAuthMiddleware,
  createServerModeOriginMiddleware,
  sanitizeServerModeStatus,
} from './security/server-mode-middleware.js'
import { OFFICIAL_HOSTED_APP_URL } from './security/web-origin-allowlist.js'
import { createWsTicketStore } from './security/ws-ticket-store.js'
import {
  BranchNotFoundError,
  deleteBranch,
  loadCanvasBranches,
  setHead as setHeadPersist,
  updateBranchTip,
} from './store/branches-store.js'
import { canvasExists, saveCanvas } from './store/canvas-store.js'
import { isCorruptStoredDataError } from './store/corrupt-stored-data.js'
import { countAliveNodes } from './store/count-alive-nodes.js'
import { getDoc, peekDoc } from './store/doc-cache.js'
import { FileVersionStore } from './store/version-store.js'
import { withWorkspaceWriteLock } from './store/workspace-lock.js'

export type { AppOptions, ServerModeAppOptions } from './app-types.js'

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

setResolveViewportFn(resolveViewportRequest)

export function createApp(options: AppOptions) {
  if (options.authMode === 'local-daemon' && 'authStrategy' in options) {
    throw new Error('local-daemon mode must not receive authStrategy')
  }

  const app = new Hono()

  const instanceId = options.instanceId ?? randomUUID()
  // The signing identity behind /api/runtime/ping's `identity`,
  // /api/runtime/verify, and pairing-token response signatures.
  const identity = options.identity ?? createDaemonIdentity({ dataDir: getDataDir() })
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

  app.use('*', async (_c, next) => {
    options.touch()
    await next()
  })

  app.use('*', async (c, next) => {
    await next()
    setBaselineSecurityHeaders(c.res.headers)
  })

  // The hosted-origin OAuth surface is mounted below, but its store has to
  // exist before the /api/* auth middleware is built: the same store both
  // mints an access grant (at /token) and is the only thing that can later
  // recognize the token that grant issued. Two instances would mean tokens
  // minted by one and unknown to the other.
  const oauthAuthz =
    options.authMode === 'local-daemon' &&
    options.oauthClientRegistry &&
    options.oauthClientRegistry.length > 0
      ? {
          store: createOAuthTransactionStore(),
          registry: options.oauthClientRegistry,
          allowedWebOrigins: options.allowedWebOrigins ?? [],
        }
      : undefined

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
    // Either credential: the daemon token (full authority, unchanged) or an
    // OAuth access token, which is additionally checked against the route's
    // declared scope. Both fail identically.
    app.use('/api/*', createDaemonAuthMiddleware(token, oauthAuthz?.store, options.pairing?.tokens))
  }

  // Hosted-origin OAuth 2.1 authorization-server surface (ADR-0005). Local-
  // daemon mode only — server-mode has its own external-IdP oauth-jwt
  // resource-server strategy and is not itself an authorization server.
  // Unmounted entirely unless an operator configures at least one
  // redirect_uri registry entry (empty-by-default, like allowedWebOrigins).
  if (oauthAuthz) {
    const oauthAuthzRoutes = createOAuthAuthzRouter({
      store: oauthAuthz.store,
      registry: oauthAuthz.registry,
    })
    // Attached per explicit path, NOT via a sub-app: Hono merges a sub-app's
    // `use('*')` into the parent as `/*`, so a sub-app mounted at '/' would
    // run this host guard and CORS ahead of every other route's own policy —
    // an OPTIONS preflight for /mcp would be answered here before
    // createMcpHttpOriginMiddleware ever ran.
    for (const path of OAUTH_AUTHZ_PATHS) {
      // Host guard on EVERY path of the surface, including /authorize: a
      // spoofed non-loopback Host is a DNS-rebinding vector here exactly as
      // on /api/*, and it must be rejected before an OPTIONS preflight could
      // short-circuit past it.
      app.use(path, createApiHostGuardMiddleware(options.authMode))
    }
    // CORS covers only OAUTH_AUTHZ_CORS_PATHS — the metadata documents and
    // /token — never the /authorize pair. Reflecting an allowed web origin on
    // the approval endpoints would let the requesting page read the approval
    // screen and script its POST cross-site, which is the whole thing the
    // approval step exists to prevent. See oauth-authz.ts.
    for (const path of OAUTH_AUTHZ_CORS_PATHS) {
      app.use(path, createApiLoopbackCorsMiddleware(oauthAuthz.allowedWebOrigins))
    }
    app.route('/', oauthAuthzRoutes)
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

  // The modern (2026-07-28) serving entry: per-request factory, no protocol
  // session — the same stateless idiom this endpoint has always used, now
  // spec-level. `legacy: 'reject'` because 2025-era traffic is deliberately
  // NOT served by this handler: the hand-wired legacy path below keeps
  // `enableJsonResponse: true`, which the entry's built-in legacy fallback
  // does not set, and changing legacy clients' response framing (JSON body →
  // SSE) would break the stdio proxy and the web app's daemon client.
  const modernMcpHandler = createMcpHandler(() => createMcpServer(), {
    legacy: 'reject',
    onerror: (error) => {
      httpLog.warning({ err: error }, 'mcp-http:modern-error')
    },
  })

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
      const server = await createMcpServer()
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

  if (options.authMode === 'local-daemon' && options.pairing !== undefined) {
    // Pairing-grant routes are local-daemon only by design (the consent
    // model assumes the daemon's own served UI and loopback reachability).
    app.route('/', createPairingRouter({ ...options.pairing, identity }))
  }

  // server-core's OpenCanvas /api/v1 surface (workspace tree, canvasId +
  // alias world). Mounted at '/' because its routes carry full /api/v1/*
  // paths; the /api/* auth middlewares registered above already cover it.
  if (options.serverDeps) {
    app.route('/', createOpenCanvasServer(options.serverDeps).app)
  }

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
  app.route('/', createSyncSseRouter())
  app.route('/', createDebugRouter({ token }))
  app.route('/', createStatusRouter())
  // POST /api/ws-ticket (ADR-0005) is a local-daemon-only bridge from an
  // OAuth grant to a WS upgrade — server-mode's WS auth goes through its own
  // AsyncAuthStrategy and never needs this. Mounted even when no OAuth
  // registry is configured (oauthAuthz undefined): the route always 401s in
  // that case because there is no grantStore to verify a presented bearer
  // against, same "declared but always-refuses when unconfigured" shape as
  // the rest of this surface.
  if (options.authMode === 'local-daemon') {
    app.route(
      '/',
      createWsTicketRouter({
        grantStore: oauthAuthz?.store,
        ticketStore: options.wsTicketStore ?? createWsTicketStore(),
      }),
    )
  }
  app.route(
    '/',
    createRuntimeRouter({
      token,
      mcpAuth: mcpAuth ?? undefined,
      instanceId,
      identity,
      touch: options.touch,
      getStatus: options.authMode === 'server-mode' ? serverModeGetStatus! : options.getStatus,
      shutdown: options.shutdown,
      grantStore: oauthAuthz?.store,
      pairingTokens: options.authMode === 'local-daemon' ? options.pairing?.tokens : undefined,
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
          doc.import(clone.export({ mode: 'snapshot' }))
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
        // The whole read-modify-write (branch lookup, live-doc read, the
        // pre-merge snapshot, the tip/HEAD writes, and their doc
        // reconcile+save) runs inside one workspace-lock hold. getDoc(sid,
        // slug) alone is unlocked, so a concurrent rename/delete that runs
        // its whole lock-protected section between this unlocked read and
        // the later saveCanvas() calls below would find no row left at
        // this slug and silently insert a phantom canvas (or resurrect
        // deleted content) instead of erroring or landing on the renamed
        // row. updateBranchTip/setHeadPersist/deleteBranch already acquire
        // this same per-workspace lock internally (branches-store.ts), so
        // they re-enter via the AsyncLocalStorage chain rather than
        // deadlocking — mirrors live-doc.ts's POST /update handler.
        performMerge: async (sid, slug, { source, into, dryRun }) =>
          withWorkspaceWriteLock(sid, async () => {
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

            // The merge base is the common ancestor: the per-peer minimum
            // ("meet") of target's and source's version vectors, checked out
            // against the live doc's full history. A peer counted on only one
            // side contributes nothing to the ancestor and is omitted from the
            // meet (its count would be 0); an all-omitted (empty) meet checks
            // out to genesis, which correctly classifies every source element
            // as new rather than resurrected.
            const meetVersion = (a: VersionVector, b: VersionVector): VersionVector => {
              const bCounts = b.toJSON()
              const meet = new Map<PeerID, number>()
              for (const [peer, aCount] of a.toJSON()) {
                const bCount = bCounts.get(peer)
                if (bCount === undefined) continue
                const count = Math.min(aCount, bCount)
                if (count > 0) meet.set(peer, count)
              }
              return new VersionVector(meet)
            }
            const baseFrontiers = liveDoc.vvToFrontiers(
              meetVersion(targetDoc.version(), sourceDoc.version()),
            )
            const baseDoc = checkoutCloneOrThrow(
              liveDoc,
              baseFrontiers,
              `${sid}/branches/${slug}.json#merge-base`,
              'merge base could not be checked out against the live document',
            )

            const badges = detectMergeBadges({
              base: baseDoc,
              target: targetDoc,
              source: sourceDoc,
              preview: previewDoc,
            })

            const previewElementCount = countAliveNodes(previewDoc)
            const targetElementCount = countAliveNodes(targetDoc)
            const sourceElementCount = countAliveNodes(sourceDoc)

            // Diff elements between target and preview so the UI can highlight
            // new / changed / conflict elements after commit.
            const tMap = toElementMap(targetDoc)
            const pMap = toElementMap(previewDoc)
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
            const conflictElementIds = Array.from(new Set(badges.map((b) => b.elementId)))

            if (dryRun) {
              // For dry runs, return every current node + edge so MergeDialog can
              // render a read-only preview. Payload shape is deliberately the
              // nodes-model equivalent of the retired Excalidraw-style elements
              // list; the field stays untyped (z.array(z.unknown())) and no
              // consumer reads it today.
              const previewElements = [...pMap.values()]
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
              liveDoc.import(previewDoc.export({ mode: 'snapshot' }))
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
                liveDoc.import(previewDoc.export({ mode: 'snapshot' }))
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
          }),
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

  // Hosted-first end state (supersedes ADR-0001's optional full-UI serving,
  // see the ADR addendum): the daemon serves exactly ONE page — /pair, the
  // pairing consent trust anchor that must come from the daemon's own
  // origin — plus the assets it needs. Every other UI path redirects to the
  // official hosted app, which reaches this daemon through its default
  // origin admission + a pairing grant. Accepted tradeoff: a fully-offline
  // FIRST run has no canvas UI; the installed PWA is the offline path.
  app.get('*', async (c) => {
    if (isReservedUiPath(c.req.path)) {
      return c.notFound()
    }
    if (c.req.path !== '/pair') {
      return c.redirect(OFFICIAL_HOSTED_APP_URL, 302)
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
      const nonce = createCspNonce()
      const runtimeConfigScript = `<script nonce="${nonce}">window.__WHITEBOARD_RUNTIME_CONFIG__ = ${runtimeConfigJson}</script>`
      const tokenScript = token
        ? `<script nonce="${nonce}">window.__WHITEBOARD_DAEMON_TOKEN__ = ${toInlineScriptJson(token)}</script>`
        : ''
      const injected = `${runtimeConfigScript}${tokenScript}`
      const withRuntimeConfig = html.includes('</head>')
        ? html.replace('</head>', `${injected}</head>`)
        : `${injected}${html}`
      return c.html(withRuntimeConfig, 200, {
        'Content-Security-Policy': pairPageCsp(nonce),
      })
    } catch {
      return c.text('Not found. Run `pnpm build` first.', 404)
    }
  })

  return app
}
