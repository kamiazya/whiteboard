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
import { createDaemonAuthMiddleware } from './routes/auth.js'
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
import { createSignInRoutes, type SignInRoutesDeps } from './routes/sign-in.js'
import { createStatusRouter } from './routes/status.js'
import { createSyncSseRouter } from './routes/sync-sse.js'
import { createTenantPeopleRouter } from './routes/tenant-people.js'
import { createViewportRouter, resolveViewportRequest } from './routes/viewport.js'
import { createWorkspacePeopleRouter } from './routes/workspace-people.js'
import { setResolveViewportFn } from './routes/ws.js'
import { createWsTicketRouter } from './routes/ws-ticket.js'
import { createApiHostGuardMiddleware } from './security/api-host-guard.js'
import { createApiLoopbackCorsMiddleware } from './security/cors-loopback.js'
import {
  type CredentialResolver,
  createCredentialResolver,
} from './security/credential-resolver.js'
import { createDaemonIdentity, type DaemonIdentity } from './security/daemon-identity.js'
import {
  buildMcpProtectedResourceMetadata,
  createLocalTokenMcpHttpAuthStrategy,
} from './security/mcp-auth.js'
import { createMcpHttpAuthMiddleware, createMcpHttpOriginMiddleware } from './security/mcp-http.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import {
  creatorAsFirstMember,
  type FirstMember,
  membershipAdmit,
  type WorkspaceAdmit,
} from './security/membership-gate.js'
import { createOAuthTransactionStore } from './security/oauth-authz-transactions.js'
import { planServerModeAuth } from './security/server-mode-auth-plan.js'
import {
  createServerModeApiAuthMiddleware,
  createServerModeAsyncAuthMiddleware,
  createServerModeMcpAuthMiddleware,
  createServerModeOriginMiddleware,
  sanitizeServerModeStatus,
} from './security/server-mode-middleware.js'
import type { AllowedWebOrigins } from './security/web-origin-allowlist.js'
import { OFFICIAL_HOSTED_APP_URL } from './security/web-origin-allowlist.js'
import { createWsTicketStore } from './security/ws-ticket-store.js'
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

setResolveViewportFn(resolveViewportRequest)

/**
 * S8 slice 2's membership wiring, decided once: the `/api/*` middleware
 * gates registry rows over the `workspace` extractor, and the two surfaces
 * that decide membership themselves (the SSE transport per doc key; the
 * workspace list, which filters rather than refuses) reuse the grant the
 * middleware stashed. Both are undefined outside local-daemon mode — server
 * mode authorizes through its own `AsyncAuthStrategy`, whose credentials
 * are all operator-issued kinds `workspaceAccess` admits, so a gate there
 * would be a no-op — and for a caller that wired no member-profile store
 * (an ad-hoc/test app), which gets no gate rather than one that always
 * refuses.
 */
function membershipWiring(options: AppOptions): {
  gate: { members: MemberProfileStore } | undefined
  admit: WorkspaceAdmit | undefined
  firstMember: FirstMember | undefined
} {
  // Server mode (ADR-0046 decision 10): its own middleware gates the routes,
  // and every workspace is members-only from the start.
  if (options.authMode === 'server-mode') {
    const members = options.people?.members
    return members === undefined
      ? { gate: undefined, admit: undefined, firstMember: undefined }
      : {
          gate: undefined,
          admit: membershipAdmit(members, { membersOnlyByDefault: true }),
          firstMember: creatorAsFirstMember(members),
        }
  }
  if (options.members === undefined)
    return { gate: undefined, admit: undefined, firstMember: undefined }
  return {
    gate: { members: options.members },
    admit: membershipAdmit(options.members),
    firstMember: undefined,
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
 * Hosted-first end state (supersedes ADR-0001's optional full-UI serving,
 * see the ADR addendum): the daemon serves exactly ONE page — `/pair`, the
 * pairing consent trust anchor that must come from the daemon's own origin —
 * plus the assets it needs. Every other UI path redirects to the official
 * hosted app, which reaches this daemon through its default origin admission
 * plus a pairing grant. Accepted tradeoff: a fully-offline FIRST run has no
 * canvas UI; the installed PWA is the offline path.
 *
 * `daemonPort` is captured by the caller rather than read from `getStatus()`
 * in here: the port is fixed for the app instance's lifetime, while
 * `getStatus()` also computes `app.buildPresent` via a synchronous
 * `existsSync` (see http-server.ts) that must run fresh per real status
 * check, not on every SPA page load.
 */
function mountPairPageUi(app: Hono, daemonPort: number, token: string | undefined): void {
  for (const pattern of ['/fonts/*', '/assets/*']) {
    app.use(pattern, serveStatic({ root: DIST_WEB_APP_DIR }))
  }

  app.get('*', async (c) => {
    if (isReservedUiPath(c.req.path)) return c.notFound()
    if (c.req.path !== '/pair') return c.redirect(OFFICIAL_HOSTED_APP_URL, 302)
    try {
      const html = await readFile(join(DIST_WEB_APP_DIR, 'index.html'), 'utf-8')
      return c.html(...injectRuntimeConfig(html, daemonPort, token))
    } catch {
      return c.text('Not found. Run `pnpm build` first.', 404)
    }
  })
}

/**
 * The pair page's HTML with this daemon's runtime config inlined, and the CSP
 * whose nonce admits exactly those scripts.
 *
 * The daemon token is deliberately NOT part of
 * `__WHITEBOARD_RUNTIME_CONFIG__` (see shared/token-store.ts) — it ships in
 * its own global so it never rides along inside an object that logging or
 * error reporting could serialize wholesale.
 */
function injectRuntimeConfig(
  html: string,
  daemonPort: number,
  token: string | undefined,
): [string, 200, Record<string, string>] {
  const runtimeConfigJson = toInlineScriptJson({
    // Composed from 127.0.0.1 + port (not getStatus().baseUrl) so the value
    // is always a loopback origin, even when the daemon binds 0.0.0.0.
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
  return [withRuntimeConfig, 200, { 'Content-Security-Policy': pairPageCsp(nonce) }]
}

/**
 * The `/api/*` chain, whose ORDER is the security property.
 *
 * Both modes put the host guard first, ahead of CORS, so a spoofed
 * non-loopback Host (DNS rebinding) is rejected before the OPTIONS
 * short-circuit can hand out a 204 — otherwise a preflight would bypass the
 * guard entirely.
 *
 * Server-mode takes no membership gate (S8 slice 2 is local-daemon only): it
 * authorizes through its own `AsyncAuthStrategy` (external-IdP oauth-jwt),
 * not `credential-resolver.ts`'s `ResolvedGrant` — the type `workspaceAccess`
 * and its ADR-0041 L1/pairing membership model apply to. There is no
 * person-vs-pairing distinction to gate there.
 */
function mountApiAuth(
  app: Hono,
  options: AppOptions,
  credentialResolver: CredentialResolver,
  gate: { members: MemberProfileStore } | undefined,
): void {
  app.use('/api/*', createApiHostGuardMiddleware(options.authMode))
  if (options.authMode === 'server-mode') {
    app.use('/api/*', createServerModeApiAuthMiddleware(options.authStrategy, options.people))
    return
  }
  // Cross-origin loopback requests (the apps/web dev server on
  // localhost:5173 reaching the daemon on 127.0.0.1:3099) are allowed, and
  // CORS runs BEFORE the auth guard so an OPTIONS preflight short-circuits
  // to 204 without a bearer token, while every other method — GET included,
  // see auth.js — falls through to the auth chain unchanged.
  app.use('/api/*', createApiLoopbackCorsMiddleware(options.allowedWebOrigins ?? []))
  // Every credential this daemon accepts is resolved in ONE place, and the
  // resolver is a required argument — see `security/credential-resolver.ts`
  // for why that is load-bearing rather than tidy. What stays here is the
  // route-scope policy and the refusal shape, which are this surface's.
  app.use('/api/*', createDaemonAuthMiddleware(credentialResolver, gate))
}

type OAuthAuthzWiring = {
  store: ReturnType<typeof createOAuthTransactionStore>
  registry: NonNullable<Extract<AppOptions, { authMode: 'local-daemon' }>['oauthClientRegistry']>
  allowedWebOrigins: AllowedWebOrigins | readonly string[]
}

/**
 * The hosted-origin OAuth 2.1 authorization-server surface (ADR-0005).
 *
 * Attached per explicit PATH, not via a sub-app: Hono merges a sub-app's
 * `use('*')` into the parent as `/*`, so a sub-app mounted at '/' would run
 * this host guard and CORS ahead of every other route's own policy — an
 * OPTIONS preflight for `/mcp` would be answered here before
 * `createMcpHttpOriginMiddleware` ever ran.
 *
 * CORS covers only `OAUTH_AUTHZ_CORS_PATHS` — the metadata documents and
 * `/token` — never the `/authorize` pair. Reflecting an allowed web origin on
 * the approval endpoints would let the requesting page read the approval
 * screen and script its POST cross-site, which is the whole thing the
 * approval step exists to prevent (see oauth-authz.ts).
 */
function mountOAuthAuthz(
  app: Hono,
  authMode: AppOptions['authMode'],
  oauthAuthz: OAuthAuthzWiring,
): void {
  // Host guard on EVERY path of the surface, including /authorize: a spoofed
  // non-loopback Host is a DNS-rebinding vector here exactly as on /api/*,
  // and it must be rejected before an OPTIONS preflight could short-circuit
  // past it.
  for (const path of OAUTH_AUTHZ_PATHS) {
    app.use(path, createApiHostGuardMiddleware(authMode))
  }
  for (const path of OAUTH_AUTHZ_CORS_PATHS) {
    app.use(path, createApiLoopbackCorsMiddleware(oauthAuthz.allowedWebOrigins))
  }
  app.route('/', createOAuthAuthzRouter({ store: oauthAuthz.store, registry: oauthAuthz.registry }))
}

/**
 * `/mcp`'s own chain: origin policy (server-mode checks `allowedOrigins`,
 * local-daemon allows loopback only), auth (server-mode's
 * `AsyncAuthStrategy` with the `mcp:call` scope, local-daemon's daemon
 * token), and a body limit so an oversized JSON-RPC payload cannot OOM the
 * daemon.
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
}

/**
 * The routers only server mode mounts: a workspace's people as its owners
 * manage them (ADR-0049). The local daemon's members are still passkeys,
 * mounted by `mountLocalDaemonRouters`.
 */
function mountServerModeRouters(app: Hono, options: AppOptions): void {
  if (options.authMode !== 'server-mode' || options.people === undefined) return
  const { members, roles, invitations, origin, administration } = options.people
  app.route('/', createWorkspacePeopleRouter({ members, roles, invitations, origin }))
  app.route('/', createTenantPeopleRouter({ members, invitations, administration, origin }))
}

/**
 * The routers that exist only in local-daemon mode, each with the condition
 * that decides whether it can answer at all.
 *
 * Pairing is local-daemon by design: the consent model assumes the daemon's
 * own served UI and loopback reachability. Membership (ADR-0041 S0-4) needs
 * the workspace-existence check only `ServerDeps`' `workspaceDocuments`
 * answers, so unlike pairing it also requires `serverDeps`. The read plane's
 * workspace-key route (ADR-0042 decisions 1/3/5) has membership's condition
 * plus `replicaKeys`, since a member's session is what it hands the key to.
 *
 * The ws-ticket bridge is mounted even with no OAuth registry configured:
 * the resolver then has no OAuth branch, so nothing presented can resolve to
 * an `oauth-grant` and the route always 401s — the same "declared but
 * always-refuses when unconfigured" shape as the rest of this surface.
 */
function mountLocalDaemonRouters(
  app: Hono,
  options: AppOptions,
  identity: DaemonIdentity,
  credentialResolver: CredentialResolver,
): void {
  if (options.authMode !== 'local-daemon') return

  if (options.pairing !== undefined) {
    app.route('/', createPairingRouter({ ...options.pairing, identity, members: options.members }))
  }
  const { members, pairing, serverDeps, replicaKeys } = options
  if (pairing !== undefined && members !== undefined && serverDeps !== undefined) {
    app.route(
      '/',
      createMembershipRouter({
        members,
        tokens: pairing.tokens,
        credentials: pairing.credentials,
        workspaceExists: (workspaceId) => serverDeps.workspaceDocuments.exists(workspaceId),
      }),
    )
    if (replicaKeys !== undefined) {
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
  }

  app.route(
    '/',
    createWsTicketRouter({
      credentialResolver,
      ticketStore: options.wsTicketStore ?? createWsTicketStore(),
    }),
  )
}

/**
 * What `wb_pairing_link_create` reads about this daemon.
 *
 * There is no context in server-mode (no single daemon origin to embed the
 * way local-daemon has) nor in a local-daemon caller that supplies no
 * `daemonBaseUrl` (an ad-hoc or test caller with no real HTTP listener); the
 * tool treats "no context" as the standalone case, and the REASON tells the
 * two apart. The stdio-entrypoint reason lives in mcp/index.ts's own
 * default, since this module is never on that path.
 */
function pairingToolWiring(options: AppOptions): {
  pairingLinkContext:
    | { daemonBaseUrl: string; allowedWebOrigins: AllowedWebOrigins | undefined }
    | undefined
  pairingUnavailableReason: PairingUnavailableReason
} {
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

  return { pairingLinkContext, pairingUnavailableReason }
}

/**
 * The three things a credential check needs, built in the one order they can
 * be built in.
 *
 * The OAuth store has to exist before the `/api/*` auth middleware: the same
 * store both mints an access grant (at `/token`) and is the only thing that
 * can later recognize the token that grant issued, so two instances would
 * mean tokens minted by one and unknown to the other.
 */
function credentialWiring(options: AppOptions, token: string | undefined) {
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

  return { oauthAuthz, credentialResolver, mcpAuth }
}

/**
 * Everything `createApp` DERIVES from its options before a single route is
 * mounted — one place to read what this composition actually has, so the
 * mounting below is a list of surfaces rather than a list of conditions.
 */
function appWiring(options: AppOptions) {
  const instanceId = options.instanceId ?? randomUUID()
  const { pairingLinkContext, pairingUnavailableReason } = pairingToolWiring(options)

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

  const { oauthAuthz, credentialResolver, mcpAuth } = credentialWiring(options, token)

  return {
    instanceId,
    pairingLinkContext,
    pairingUnavailableReason,
    identity,
    token,
    oauthAuthz,
    credentialResolver,
    mcpAuth,
    serverModeGetStatus,
  }
}

export function createApp(options: AppOptions) {
  const membership = membershipWiring(options)
  if (options.authMode === 'local-daemon' && 'authStrategy' in options) {
    throw new Error('local-daemon mode must not receive authStrategy')
  }

  const app = new Hono()

  const wiring = appWiring(options)
  const { instanceId, pairingLinkContext, pairingUnavailableReason } = wiring
  const { identity, token, oauthAuthz, credentialResolver, mcpAuth, serverModeGetStatus } = wiring

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

  mountApiAuth(app, options, credentialResolver, membership.gate)

  // Hosted-origin OAuth 2.1 authorization-server surface (ADR-0005). Local-
  // daemon mode only — server-mode has its own external-IdP oauth-jwt
  // resource-server strategy and is not itself an authorization server.
  // Unmounted entirely unless an operator configures at least one
  // redirect_uri registry entry (empty-by-default, like allowedWebOrigins).
  if (oauthAuthz) mountOAuthAuthz(app, options.authMode, oauthAuthz)

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

  // Passkey pins exist only where pairing does (ADR-0039): the promote
  // route verifies against them, and a composition without any refuses an
  // attestation as naming an unknown credential.
  const credentials = options.authMode === 'local-daemon' ? options.pairing?.credentials : undefined
  mountLocalDaemonRouters(app, options, identity, credentialResolver)
  mountServerModeRouters(app, options)

  // server-core's /api/v1 document surface (workspace tree, documentId +
  // alias world). Mounted at '/' because its routes carry full /api/v1/*
  // paths; the /api/* auth middlewares registered above already cover it.
  if (options.serverDeps) {
    app.route('/', createDocumentServer(options.serverDeps).app)
  }

  const admit = membership.admit

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
      ...membershipRouterOptions(membership),
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

  mountPairPageUi(app, options.getStatus().port, token)

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
