import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { createServer as createDocumentServer } from '@kamiazya/whiteboard-server-core'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
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
import type { PairingUnavailableReason } from './mcp/pairing-link.js'
import { tracingMiddleware } from './observability/http-tracing.js'
import { createCspNonce, pairPageCsp } from './pair-page-csp.js'
import { DEFAULT_REPLICA_LEASE_TTL_MS } from './replica-env.js'
import { createDaemonAuthMiddleware, membershipAdmit } from './routes/auth.js'
import { createDebugRouter } from './routes/debug.js'
import { createDocumentRouter } from './routes/document.js'
import { createExportRouter } from './routes/export.js'
import { createFilesRouter } from './routes/files.js'
import { createFontsRouter } from './routes/fonts.js'
import { createMcpRouter } from './routes/mcp.js'
import { createMembershipRouter } from './routes/membership.js'
import {
  createOAuthAuthzRouter,
  OAUTH_AUTHZ_CORS_PATHS,
  OAUTH_AUTHZ_PATHS,
} from './routes/oauth-authz.js'
import { createPairingRouter } from './routes/pairing.js'
import { createReplicaKeyRouter } from './routes/replica-key.js'
import { createRuntimeRouter } from './routes/runtime.js'
import { createStatusRouter } from './routes/status.js'
import { createSyncSseRouter } from './routes/sync-sse.js'
import { createViewportRouter, resolveViewportRequest } from './routes/viewport.js'
import { setResolveViewportFn } from './routes/ws.js'
import { createWsTicketRouter } from './routes/ws-ticket.js'
import { createApiHostGuardMiddleware } from './security/api-host-guard.js'
import { createApiLoopbackCorsMiddleware } from './security/cors-loopback.js'
import { createCredentialResolver } from './security/credential-resolver.js'
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
import { FileVersionStore } from './store/version-store.js'

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
  // wb_pairing_link_create's daemon context — undefined in server-mode (no
  // single daemon origin to embed the way local-daemon has) and in any
  // local-daemon caller that supplies no daemonBaseUrl (ad-hoc/test
  // callers); the tool itself treats "no context" as the standalone case.
  const pairingLinkContext =
    options.authMode === 'local-daemon' && options.daemonBaseUrl !== undefined
      ? {
          daemonBaseUrl: options.daemonBaseUrl,
          // The raw provider (not a resolved snapshot) so the tool's
          // allowlist check re-reads the SAME live set CORS/mcp-origin/WS
          // consult on every call — options.allowedWebOrigins is itself a
          // function backed by pairing grants approved at runtime, and
          // resolving it once here would freeze the tool's advisory text
          // stale for the rest of the process the moment a grant is
          // approved after startup.
          allowedWebOrigins: options.allowedWebOrigins,
        }
      : undefined
  // Only consulted by wb_pairing_link_create when pairingLinkContext above is
  // undefined, so it only has to distinguish the two ways THAT happens here
  // (server-mode has no pairing concept at all; local-daemon with no
  // daemonBaseUrl is an ad-hoc/test caller with no real HTTP listener) — the
  // stdio-entrypoint reason lives in mcp/index.ts's own default, since this
  // module is never on that path.
  const pairingUnavailableReason: PairingUnavailableReason =
    options.authMode === 'server-mode' ? 'server-mode' : 'no-daemon-base-url'
  // The signing identity behind /api/runtime/ping's `identity`,
  // /api/runtime/verify, and pairing-token response signatures.
  const identity = options.identity ?? createDaemonIdentity({ dataDir: getDataDir() })
  const token = options.authMode === 'local-daemon' ? options.token : undefined

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

  // Built ONCE and shared by every surface that checks a credential. A
  // surface takes it as a required argument, so a credential cannot go
  // missing on one of them while the others keep working — which is the
  // defect `security/credential-resolver.ts` exists to make impossible.
  const localDaemon = options.authMode === 'local-daemon' ? options : undefined
  const credentialResolver = createCredentialResolver({
    daemonToken: token,
    grantStore: oauthAuthz?.store,
    pairingTokens: localDaemon?.pairing?.tokens,
    macaroonRootKey: localDaemon?.macaroonRootKey,
    redeemTicket: localDaemon?.wsTicketStore?.redeemTicket,
  })
  // Built AFTER the resolver, over it. `/mcp`'s own policy (which grants it
  // admits) lives in the strategy; the credential check does not.
  const mcpAuth =
    localDaemon !== undefined
      ? createLocalTokenMcpHttpAuthStrategy({
          resolver: credentialResolver,
          protectedResourceMetadata: localDaemon.mcpProtectedResourceMetadata,
        })
      : undefined

  if (options.authMode === 'server-mode') {
    // No membership gate here (S8 slice 2 is local-daemon only): this branch
    // authorizes through its own `AsyncAuthStrategy` (external-IdP
    // oauth-jwt), not `credential-resolver.ts`'s `ResolvedGrant` — the type
    // `workspaceAccess` and its ADR-0041 L1/pairing membership model apply
    // to. There is no person-vs-pairing distinction to gate here.
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
    // Every credential this daemon accepts is resolved in ONE place, and the
    // resolver is a required argument — see `security/credential-resolver.ts`
    // for why that is load-bearing rather than tidy. What stays here is the
    // route-scope policy and the refusal shape, which are this surface's.
    //
    // S8 slice 2: the membership gate rides the same middleware, over the
    // route-scope registry's `workspace` extractor. `options.members` is
    // undefined only for a caller that has not wired the member-profile
    // store at all (an ad-hoc/test app), which gets no gate rather than one
    // that always refuses.
    app.use(
      '/api/*',
      createDaemonAuthMiddleware(
        credentialResolver,
        options.members === undefined ? undefined : { members: options.members },
      ),
    )
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
  const modernMcpHandler = createMcpHandler(
    () => createMcpServer({ pairing: pairingLinkContext, pairingUnavailableReason }),
    {
      legacy: 'reject',
      onerror: (error) => {
        httpLog.warning({ err: error }, 'mcp-http:modern-error')
      },
    },
  )

  app.route(
    '/',
    createMcpRouter({ modernMcpHandler, pairingLinkContext, pairingUnavailableReason }),
  )

  // Passkey pins exist only where pairing does (ADR-0039): the promote route
  // below verifies against them, and a composition without any refuses an
  // attestation as naming an unknown credential.
  const credentials = options.authMode === 'local-daemon' ? options.pairing?.credentials : undefined
  if (options.authMode === 'local-daemon' && options.pairing !== undefined) {
    // Pairing-grant routes are local-daemon only by design (the consent
    // model assumes the daemon's own served UI and loopback reachability).
    app.route('/', createPairingRouter({ ...options.pairing, identity, members: options.members }))
  }
  // Membership routes (ADR-0041 S0-4) need the workspace-existence check
  // that only ServerDeps' workspaceDocuments answers — so, unlike the
  // pairing router above, they also require serverDeps.
  if (
    options.authMode === 'local-daemon' &&
    options.pairing !== undefined &&
    options.members !== undefined &&
    options.serverDeps !== undefined
  ) {
    const { members, pairing, serverDeps } = options
    app.route(
      '/',
      createMembershipRouter({
        members,
        tokens: pairing.tokens,
        credentials: pairing.credentials,
        workspaceExists: (workspaceId) => serverDeps.workspaceDocuments.exists(workspaceId),
      }),
    )
  }
  // The read plane's workspace-key route (ADR-0042 decisions 1/3/5). Same
  // mount condition as membership above, plus `replicaKeys` — a member's
  // session is what this route hands the key to, so it needs the same
  // membership lookup and workspace-existence check.
  if (
    options.authMode === 'local-daemon' &&
    options.pairing !== undefined &&
    options.members !== undefined &&
    options.serverDeps !== undefined &&
    options.replicaKeys !== undefined
  ) {
    const { members, serverDeps, replicaKeys } = options
    app.route(
      '/',
      createReplicaKeyRouter({
        keys: replicaKeys,
        members,
        leaseTtlMs: options.replicaLeaseTtlMs ?? DEFAULT_REPLICA_LEASE_TTL_MS,
        workspaceExists: (workspaceId) => serverDeps.workspaceDocuments.exists(workspaceId),
        credentialResolver,
      }),
    )
  }

  // server-core's /api/v1 document surface (workspace tree, documentId +
  // alias world). Mounted at '/' because its routes carry full /api/v1/*
  // paths; the /api/* auth middlewares registered above already cover it.
  if (options.serverDeps) {
    app.route('/', createDocumentServer(options.serverDeps).app)
  }

  // S8 slice 2: the same membership decision the /api/* middleware gates
  // individual routes with, bound to the resolved grant it stashed — for the
  // two surfaces that decide membership themselves rather than through the
  // registry (the SSE transport decides per doc key; the workspace list
  // filters rather than refuses). Undefined outside local-daemon mode or
  // without a member-profile store, matching the middleware's own gate.
  const admit =
    options.authMode === 'local-daemon' && options.members !== undefined
      ? membershipAdmit(options.members)
      : undefined

  app.route(
    '/',
    createDocumentRouter({
      // ADR-0035 decision 2: a version row records the DEVICE, by a name
      // that cannot rotate. The identity is built above, so this is the one
      // place that answer is known without threading it through the DI graph.
      daemonActor: identity.did,
      ...(credentials === undefined ? {} : { credentials }),
      ...(options.serverDeps === undefined ? {} : { serverDeps: options.serverDeps }),
      ...(options.onAutoVersionTrigger === undefined
        ? {}
        : { onAutoVersionTrigger: options.onAutoVersionTrigger }),
      ...(options.authMode === 'local-daemon' && options.replicaKeys !== undefined
        ? { replicaTier: options.replicaKeys.effectiveTier.bind(options.replicaKeys) }
        : {}),
      ...(admit === undefined ? {} : { admit }),
    }),
  )
  // Shared versionStore so the files router can do version-aware purge
  // and the branches router can resolve frontiers — they would each
  // instantiate their own otherwise.
  const sharedVersionStore = new FileVersionStore()
  app.route('/', createFilesRouter({ versionStore: sharedVersionStore }))
  app.route('/', createExportRouter())
  app.route('/', createFontsRouter())
  app.route('/', createViewportRouter())
  app.route('/', createSyncSseRouter(admit === undefined ? {} : { admit }))
  app.route('/', createDebugRouter({ credentialResolver }))
  app.route('/', createStatusRouter())
  // POST /api/ws-ticket (ADR-0005) is a local-daemon-only bridge from an
  // OAuth grant to a WS upgrade — server-mode's WS auth goes through its own
  // AsyncAuthStrategy and never needs this. Mounted even when no OAuth
  // registry is configured (oauthAuthz undefined): the resolver then has no
  // OAuth branch, so nothing presented can resolve to an `oauth-grant` and
  // the route always 401s — the same "declared but always-refuses when
  // unconfigured" shape as the rest of this surface.
  if (options.authMode === 'local-daemon') {
    app.route(
      '/',
      createWsTicketRouter({
        credentialResolver,
        ticketStore: options.wsTicketStore ?? createWsTicketStore(),
      }),
    )
  }
  app.route(
    '/',
    createRuntimeRouter({
      instanceId,
      identity,
      touch: options.touch,
      getStatus: options.authMode === 'server-mode' ? serverModeGetStatus! : options.getStatus,
      credentialResolver,
    }),
  )
  if (options.authMode === 'server-mode') {
    // Server-mode serves only the static placeholder above — no build
    // artifact, no runtime-config / token injection, no static asset roots.
    app.get('*', (c) => {
      if (isReservedUiPath(c.req.path)) {
        return c.notFound()
      }
      return c.html(SERVER_MODE_PLACEHOLDER_HTML)
    })
    // Same shape as the local-daemon return below, so callers see one type
    // rather than a union. Server-mode does not consult this resolver — its
    // `/api/*` goes through `createServerModeApiAuthMiddleware` over the
    // AsyncAuthStrategy — but returning it keeps the two exits honest.
    return Object.assign(app, { credentialResolver })
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

  // Returned alongside the app so the WEBSOCKET UPGRADE shares this exact
  // instance. `http-server.ts` owns that surface and is outside the Hono app,
  // so without this it would have to build a second resolver from a second
  // copy of the config — and a credential added to one copy and not the other
  // is the defect this whole component exists to make impossible.
  //
  // Attached to the return rather than threaded through the options because
  // `createApp` has 133 call sites: making the resolver a required OPTION
  // would be a mechanical rewrite of all of them, and a mechanical rewrite is
  // where the last precedence bug came from.
  return Object.assign(app, { credentialResolver })
}
