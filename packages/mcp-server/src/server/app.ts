import { randomUUID } from 'node:crypto'
import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { createServer as createDocumentServer } from '@kamiazya/whiteboard-server-core'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { setBaselineSecurityHeaders, shouldLogMcpHttpDebug } from './app-helpers.js'
import type { AppOptions } from './app-types.js'
import { DIST_WEB_APP_DIR, getDataDir } from './config.js'
import { getLogger, getLogLevel, setLogLevel } from './log.js'
import { createMcpServer } from './mcp/index.js'
import { tracingMiddleware } from './observability/http-tracing.js'
import { DEFAULT_REPLICA_LEASE_TTL_MS } from './replica-env.js'
import { createDaemonAuthMiddleware } from './routes/auth.js'
import { createDebugRouter } from './routes/debug.js'
import { createDocumentRouter } from './routes/document.js'
import { createExportRouter } from './routes/export.js'
import { createFilesRouter } from './routes/files.js'
import { createFontsRouter } from './routes/fonts.js'
import { createMcpRouter } from './routes/mcp.js'
import { createReplicaKeyRouter } from './routes/replica-key.js'
import { createRuntimeRouter } from './routes/runtime.js'
import { createSignInRoutes, type SignInRoutesDeps } from './routes/sign-in.js'
import { createStatusRouter } from './routes/status.js'
import { createSyncSseRouter } from './routes/sync-sse.js'
import { createTenantPeopleRouter } from './routes/tenant-people.js'
import { createWorkspacePeopleRouter } from './routes/workspace-people.js'
import {
  type CredentialResolver,
  createCredentialResolver,
} from './security/credential-resolver.js'
import { createDaemonIdentity } from './security/daemon-identity.js'
import {
  buildMcpProtectedResourceMetadata,
  createLocalTokenMcpHttpAuthStrategy,
} from './security/mcp-auth.js'
import { createMcpHttpAuthMiddleware } from './security/mcp-http.js'
import {
  callerUserId,
  creatorAsFirstMember,
  type FirstMember,
  membershipAdmit,
  type WorkspaceAdmit,
} from './security/membership-gate.js'
import { serverModePeopleKeeper } from './security/people-keepers.js'
import { planServerModeAuth } from './security/server-mode-auth-plan.js'
import {
  createServerModeApiAuthMiddleware,
  createServerModeAsyncAuthMiddleware,
  createServerModeMcpAuthMiddleware,
  createServerModeOriginMiddleware,
  sanitizeServerModeStatus,
} from './security/server-mode-middleware.js'
import { mountServerModeWebApp } from './server-mode-web-app.js'
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

/**
 * Server mode's membership wiring (ADR-0046 decision 10): its own middleware
 * gates the routes, every workspace is members-only from the start, and the
 * two surfaces that decide membership themselves (the SSE transport per doc
 * key; the workspace list, which filters rather than refuses) reuse the
 * grant the middleware stashed. The local daemon has one person (ADR-0050
 * decision 3), so it has none.
 */
function membershipWiring(options: AppOptions): {
  admit: WorkspaceAdmit | undefined
  firstMember: FirstMember | undefined
} {
  const members = options.authMode === 'server-mode' ? options.people?.members : undefined
  return members === undefined
    ? { admit: undefined, firstMember: undefined }
    : {
        admit: membershipAdmit(members, { membersOnlyByDefault: true }),
        firstMember: creatorAsFirstMember(members),
      }
}

// Only the membership pieces that are wired, so a router given none behaves
// exactly as it did before membership existed.
function membershipRouterOptions(membership: ReturnType<typeof membershipWiring>) {
  return {
    ...(membership.admit === undefined ? {} : { admit: membership.admit }),
    ...(membership.firstMember === undefined ? {} : { firstMember: membership.firstMember }),
  }
}

/**
 * Server mode serves the web build in its image (ADR-0047), or the
 * placeholder when there is none.
 */
function mountServerModeUi(app: Hono, signIn: SignInRoutesDeps | undefined): void {
  // Before the UI catch-all, which would otherwise answer every /auth path.
  if (signIn !== undefined) app.route('/', createSignInRoutes(signIn))
  mountServerModeWebApp(app, DIST_WEB_APP_DIR)
}

/**
 * The `/api/*` auth chain. The local daemon listens on its owner-only socket
 * and no TCP port, so there is no Host to rebind and no browser Origin to
 * police (ADR-0050 decisions 2-3): the credential is the whole question.
 */
function mountApiAuth(
  app: Hono,
  options: AppOptions,
  credentialResolver: CredentialResolver,
): void {
  if (options.authMode === 'server-mode') {
    app.use('/api/*', createServerModeApiAuthMiddleware(options.authStrategy, options.people))
    return
  }
  // Every credential this daemon accepts is resolved in ONE place, and the
  // resolver is a required argument — see `security/credential-resolver.ts`
  // for why that is load-bearing rather than tidy. What stays here is the
  // route-scope policy and the refusal shape, which are this surface's.
  app.use('/api/*', createDaemonAuthMiddleware(credentialResolver))
}

/**
 * `/mcp`'s own chain: server mode's origin policy (`allowedOrigins`), auth
 * (server-mode's `AsyncAuthStrategy` with the `mcp:call` scope, local-daemon's
 * daemon token), and a body limit so an oversized JSON-RPC payload cannot OOM
 * the daemon. The local daemon listens only on its owner-only socket, where no
 * browser reaches (ADR-0050 decision 3), so it has no origin to police.
 */
function mountMcpMiddleware(
  app: Hono,
  options: AppOptions,
  mcpAuth: ReturnType<typeof createLocalTokenMcpHttpAuthStrategy> | undefined,
): void {
  if (options.authMode === 'server-mode') {
    const plan = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: options.publicBaseUrl,
      allowedOrigins: [...options.allowedOrigins],
    })
    if (plan.ok && plan.kind === 'server-mode') {
      app.use('/mcp', createServerModeOriginMiddleware(plan.allowedOrigins))
    }
    app.use(
      '/mcp',
      options.people === undefined
        ? createServerModeAsyncAuthMiddleware(options.authStrategy, ['mcp:call'])
        : createServerModeMcpAuthMiddleware(options.authStrategy, options.people),
    )
  } else {
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
}

// The people store a composition keeps, where it keeps one: what lets a
// stream remember whose it is, so losing access ends it (ADR-0049).
function syncSseOptions(options: AppOptions, admit: WorkspaceAdmit | undefined) {
  const members = options.authMode === 'server-mode' ? options.people?.members : undefined
  return {
    workspaceDocuments: options.serverDeps.workspaceDocuments,
    ...(admit === undefined ? {} : { admit }),
    ...(members === undefined ? {} : { userOf: (c: Context) => callerUserId(c, members) }),
  }
}

/** The routers only server mode mounts: a workspace's people as its owners manage them (ADR-0049). */
function mountServerModeRouters(app: Hono, options: AppOptions): void {
  if (options.authMode !== 'server-mode' || options.people === undefined) return
  const { members, roles, invitations, origin, administration } = options.people
  const keeper = serverModePeopleKeeper({ members, invitations, origin })
  app.route('/', createWorkspacePeopleRouter({ members, roles, keeper }))
  app.route('/', createTenantPeopleRouter({ members, invitations, administration, origin }))
}

/**
 * The read plane's workspace-key route (ADR-0042 decisions 1/3/5), which only
 * the local daemon serves and only where it can tell whether a workspace
 * exists and holds a key store to hand out.
 */
function mountLocalDaemonRouters(app: Hono, options: AppOptions): void {
  if (options.authMode !== 'local-daemon') return
  const { serverDeps, replicaKeys } = options
  if (replicaKeys === undefined) return
  app.route(
    '/',
    createReplicaKeyRouter({
      keys: replicaKeys,
      leaseTtlMs: options.replicaLeaseTtlMs ?? DEFAULT_REPLICA_LEASE_TTL_MS,
      workspaceExists: (workspaceId) => serverDeps.workspaceDocuments.exists(workspaceId),
    }),
  )
}

/**
 * The credential check every local-daemon surface shares, and `/mcp`'s policy
 * over it. Built ONCE: a surface takes the resolver as a required argument,
 * so a credential cannot go missing on one of them while the others keep
 * working — the defect `security/credential-resolver.ts` exists to make
 * impossible.
 */
function credentialWiring(options: AppOptions, token: string | undefined) {
  const localDaemon = options.authMode === 'local-daemon' ? options : undefined
  const credentialResolver = createCredentialResolver({
    daemonToken: token,
    macaroonRootKey: localDaemon?.macaroonRootKey,
  })
  const mcpAuth =
    localDaemon !== undefined
      ? createLocalTokenMcpHttpAuthStrategy({
          resolver: credentialResolver,
          protectedResourceMetadata: localDaemon.mcpProtectedResourceMetadata,
        })
      : undefined
  return { credentialResolver, mcpAuth }
}

/**
 * Everything `createApp` DERIVES from its options before a single route is
 * mounted — one place to read what this composition actually has, so the
 * mounting below is a list of surfaces rather than a list of conditions.
 */
function appWiring(options: AppOptions) {
  const instanceId = options.instanceId ?? randomUUID()

  // The signing identity behind /api/runtime/ping's `identity`.
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

  const { credentialResolver, mcpAuth } = credentialWiring(options, token)

  return { instanceId, identity, credentialResolver, mcpAuth, serverModeGetStatus }
}

export function createApp(options: AppOptions) {
  const membership = membershipWiring(options)
  if (options.authMode === 'local-daemon' && 'authStrategy' in options) {
    throw new Error('local-daemon mode must not receive authStrategy')
  }

  const app = new Hono()

  const { instanceId, identity, credentialResolver, mcpAuth, serverModeGetStatus } =
    appWiring(options)

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

  mountApiAuth(app, options, credentialResolver)

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

  mountMcpMiddleware(app, options, mcpAuth)

  // The modern (2026-07-28) serving entry: per-request factory, no protocol
  // session — the same stateless idiom this endpoint has always used, now
  // spec-level. `legacy: 'reject'` because 2025-era traffic is deliberately
  // NOT served by this handler: the hand-wired legacy path below keeps
  // `enableJsonResponse: true`, which the entry's built-in legacy fallback
  // does not set, and changing legacy clients' response framing (JSON body →
  // SSE) would break the stdio proxy and the web app's daemon client.
  const modernMcpHandler = createMcpHandler(() => createMcpServer(options.serverDeps), {
    legacy: 'reject',
    onerror: (error) => {
      httpLog.warning({ err: error }, 'mcp-http:modern-error')
    },
  })

  app.route('/', createMcpRouter({ modernMcpHandler, serverDeps: options.serverDeps }))

  mountLocalDaemonRouters(app, options)
  mountServerModeRouters(app, options)

  // server-core's /api/v1 document surface (workspace tree, documentId +
  // alias world). Mounted at '/' because its routes carry full /api/v1/*
  // paths; the /api/* auth middlewares registered above already cover it.
  app.route('/', createDocumentServer(options.serverDeps).app)

  const admit = membership.admit

  app.route(
    '/',
    createDocumentRouter({
      // ADR-0035 decision 2: a version row records the DEVICE, by a name
      // that cannot rotate. The identity is built above, so this is the one
      // place that answer is known without threading it through the DI graph.
      daemonActor: identity.did,
      serverDeps: options.serverDeps,
      ...(options.onAutoVersionTrigger === undefined
        ? {}
        : { onAutoVersionTrigger: options.onAutoVersionTrigger }),
      ...(options.authMode === 'local-daemon' && options.replicaKeys !== undefined
        ? { replicaTier: options.replicaKeys.effectiveTier.bind(options.replicaKeys) }
        : {}),
      ...membershipRouterOptions(membership),
    }),
  )
  // Shared versionStore so the files router can do version-aware purge
  // and the branches router can resolve frontiers — they would each
  // instantiate their own otherwise.
  const sharedVersionStore = new FileVersionStore()
  app.route('/', createFilesRouter({ versionStore: sharedVersionStore }))
  app.route('/', createExportRouter({ liveDocuments: options.serverDeps.liveDocuments }))
  app.route('/', createFontsRouter())
  app.route('/', createSyncSseRouter(syncSseOptions(options, admit)))
  app.route('/', createDebugRouter({ credentialResolver }))
  app.route('/', createStatusRouter())
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
    mountServerModeUi(app, options.signIn)
    // Same shape as the local-daemon return below, so callers see one type
    // rather than a union. Server-mode does not consult this resolver — its
    // `/api/*` goes through `createServerModeApiAuthMiddleware` over the
    // AsyncAuthStrategy — but returning it keeps the two exits honest.
    return Object.assign(app, { credentialResolver })
  }

  // The local daemon serves no UI (ADR-0050 decision 3): the hosted app
  // reaches it through the extension, so every other path is a 404.
  //
  // Returned alongside the app so a caller outside the Hono app shares this
  // exact resolver instance — a second resolver built from a second copy of
  // the config is how a credential ends up admitted on one surface and
  // refused on another.
  return Object.assign(app, { credentialResolver })
}
