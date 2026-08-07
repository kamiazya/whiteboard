import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { RuntimeStatusResponse } from '../shared/api-contracts/runtime.js'
import type { DaemonIdentity } from './security/daemon-identity.js'
import type { McpHttpAuthStrategy } from './security/mcp-auth.js'
import type { OAuthClientRegistry } from './security/oauth-authz-registry.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import type { PairingGrantStore } from './security/pairing-grant-store.js'
import type { PairingCodeStore, PairingTokenStore } from './security/pairing-session.js'
import type { AllowedWebOrigins } from './security/web-origin-allowlist.js'
import type { WsTicketStore } from './security/ws-ticket-store.js'

interface LocalDaemonAppOptions {
  authMode: 'local-daemon'
  /** OpenCanvas store/sync ports. When present, server-core's /api/v1
   *  HTTP surface (createServer(deps).app) is mounted behind the same
   *  /api/* auth as every other API route; when absent, /api/v1 stays
   *  unmounted (404). Optional so ad-hoc callers and legacy tests need no
   *  container. */
  serverDeps?: ServerDeps
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
  allowedWebOrigins?: AllowedWebOrigins
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
  /** Pairing-grant flow stores (hosted-PWA-first pairing). When present the
   *  /api/pairing routes mount, pairing session tokens are accepted by the
   *  /api auth middleware, and the caller is expected to fold
   *  `pairing.grants.origins()` into allowedWebOrigins via a provider. */
  pairing?: {
    grants: PairingGrantStore
    codes: PairingCodeStore
    tokens: PairingTokenStore
  }
  /** Daemon signing identity (security/daemon-identity.ts). Injectable for
   *  tests; when omitted, createApp loads-or-creates it from the data dir. */
  identity?: DaemonIdentity
}

export interface ServerModeAppOptions {
  authMode: 'server-mode'
  /** See LocalDaemonAppOptions.identity. */
  identity?: DaemonIdentity
  /** OpenCanvas store/sync ports. When present, server-core's /api/v1
   *  HTTP surface (createServer(deps).app) is mounted behind the same
   *  /api/* auth as every other API route; when absent, /api/v1 stays
   *  unmounted (404). Optional so ad-hoc callers and legacy tests need no
   *  container. */
  serverDeps?: ServerDeps
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
