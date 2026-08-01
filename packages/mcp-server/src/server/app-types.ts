import type { RuntimeStatusResponse } from '../shared/api-contracts/runtime.js'
import type { McpHttpAuthStrategy } from './security/mcp-auth.js'
import type { OAuthClientRegistry } from './security/oauth-authz-registry.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import type { ReconnectChallengeStore } from './security/reconnect-challenge-store.js'
import type { WebOriginTrustStore } from './security/web-origin-trust-store.js'
import type { WsTicketStore } from './security/ws-ticket-store.js'

interface LocalDaemonAppOptions {
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
  /** Exact-URI redirect_uri registry for the hosted-origin OAuth 2.1
   *  authorization-server surface (ADR-0005): /.well-known/oauth-protected-
   *  resource/api, /.well-known/oauth-authorization-server, and /token.
   *  Empty by default — the whole surface stays unmounted until an operator
   *  configures at least one client. See oauth-authz-registry.ts for why
   *  this is never derived from allowedWebOrigins. */
  oauthClientRegistry?: OAuthClientRegistry
  /** Backing store for POST /api/ws-ticket (ADR-0005). Owned by
   *  http-server.ts, which is the only other place that needs this exact
   *  instance — the raw WS `upgrade` handler redeems the ticket the route
   *  below mints. Defaults to a private, unshared store when omitted (tests
   *  exercising this app in isolation), which still makes the route work,
   *  just not reachable from a real WS upgrade outside this process. */
  wsTicketStore?: WsTicketStore
  /** Backing store for the silent-reconnect surface (POST /api/reconnect-
   *  credential, POST /api/reconnect-session). Defaults to a store rooted at
   *  the real data dir when omitted; tests inject one rooted at a scratch
   *  dir the same way wsTicketStore is injected above. */
  webOriginTrustStore?: WebOriginTrustStore
  /** Backing store for POST /api/reconnect-challenge's one-time nonce mint.
   *  Defaults to a private in-memory store when omitted; tests inject a
   *  shared instance the same way webOriginTrustStore is injected above so
   *  a test can drive challenge mint and redemption through the same
   *  store the route actually uses. */
  reconnectChallengeStore?: ReconnectChallengeStore
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
