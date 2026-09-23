import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { ALL_AUTH_SCOPES, type AuthScope } from './auth-strategy.js'
import {
  type BearerProvisioning,
  type BearerToken,
  provisionBearerPerson,
} from './bearer-provisioning.js'
import type { ResolvedGrant } from './credential-resolver.js'
import type { AuthenticatorBinding, MemberProfileStore } from './member-profile-store.js'
import { membershipRefusalFor, rememberGrant } from './membership-gate.js'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'
import { matchOrigin, parseOriginPatterns } from './origin-pattern.js'
import { resolveApiRouteScope } from './route-scope-registry.js'
import { SESSION_COOKIE, type SignInSessionStore } from './sign-in-session-store.js'

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

/**
 * ADR-0046: who a server-mode request is, and whether they reach the
 * workspace it addresses. Absent, no person is resolved and no membership is
 * checked — the bearer's scopes alone decide, as before sign-in existed.
 */
export interface ServerModePeople {
  readonly members: MemberProfileStore
  readonly sessions: SignInSessionStore
  readonly now?: () => number
  /** How a bearer's person with no user here may become one (ADR-0046
   *  decision 5). Absent: a bearer never creates a user. */
  readonly bearerProvisioning?: BearerProvisioning
}

type Refusal = { status: 401 | 403; code: string; wwwAuthenticate?: string }

// A session opened at this host comes first: it is a person already, and a
// browser that has one should not also need a bearer. Only when there is none
// (or it has expired) does the bearer decide.
async function serverModeGrant(
  c: Context,
  authStrategy: AsyncAuthStrategy,
  requiredScopes: readonly AuthScope[],
  people: ServerModePeople | undefined,
): Promise<{ grant: ResolvedGrant } | { refusal: Refusal }> {
  const session = people === undefined ? undefined : getCookie(c, SESSION_COOKIE)
  if (people !== undefined && session !== undefined) {
    const person = await people.sessions.resolve(session, (people.now ?? Date.now)())
    if (person !== null) return { grant: { kind: 'signed-in', scopes: ALL_AUTH_SCOPES, person } }
  }
  const decision = await authStrategy.authorize({
    method: c.req.method.toUpperCase(),
    path: c.req.path,
    authorizationHeader: c.req.header('authorization'),
    requiredScopes,
  })
  if (!decision.ok) return { refusal: decision }
  const { context, person, bearer } = decision
  if (person !== undefined && bearer !== undefined && people !== undefined) {
    const refused = await bearerBecomesUser(people, person, bearer)
    if (refused !== undefined) return { refusal: refused }
  }
  const scopes = 'scopes' in context ? context.scopes : ALL_AUTH_SCOPES
  return { grant: { kind: 'external-bearer', scopes, ...(person === undefined ? {} : { person }) } }
}

// A person with a user proceeds untouched; one without is admitted or refused
// by the provider declared for the bearer's issuer. An issuer no provider
// declares keeps its bearers user-less, which the membership gate answers.
async function bearerBecomesUser(
  people: ServerModePeople,
  person: AuthenticatorBinding,
  bearer: () => BearerToken,
): Promise<Refusal | undefined> {
  const provisioning = people.bearerProvisioning
  if (provisioning === undefined) return undefined
  if ((await people.members.profileForBinding(person)) !== null) return undefined
  const outcome = await provisionBearerPerson(provisioning, person, bearer())
  if (outcome.ok || outcome.reason === 'no_provider') return undefined
  return { status: 403, code: outcome.reason }
}

export function createServerModeApiAuthMiddleware(
  authStrategy: AsyncAuthStrategy,
  people?: ServerModePeople,
): MiddlewareHandler {
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
    // `daemon-token-only` routes exist only in local-daemon mode, which has
    // no AsyncAuthStrategy — server-mode has no daemon token to compare
    // against, so any request that resolves here is refused outright rather
    // than guessed at.
    if (routeScope.kind === 'daemon-token-only') {
      return c.json({ error: 'forbidden' }, 403)
    }
    const resolved = await serverModeGrant(c, authStrategy, routeScope.scopes, people)
    if ('refusal' in resolved) return buildServerModeAuthFailResponse(resolved.refusal)
    if (people === undefined) return next()
    rememberGrant(c, resolved.grant)
    const refused = await membershipRefusalFor(c, resolved.grant, people.members, {
      membersOnlyByDefault: true,
    })
    return refused ?? next()
  }
}

export function createServerModeAsyncAuthMiddleware(
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
export function createServerModeOriginMiddleware(
  allowedOrigins: readonly string[],
): MiddlewareHandler {
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

export function sanitizeServerModeStatus(
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
