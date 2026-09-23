import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { AutoVersionTrigger } from './routes/document.js'
import type { SignInRoutesDeps } from './routes/sign-in.js'
import type { DaemonIdentity } from './security/daemon-identity.js'
import type { McpProtectedResourceMetadataConfig } from './security/mcp-auth.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import type { OAuthClientRegistry } from './security/oauth-authz-registry.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import type { PairingGrantStore } from './security/pairing-grant-store.js'
import type { PairingCodeStore, PairingTokenStore } from './security/pairing-session.js'
import type { ServerModePeople } from './security/server-mode-middleware.js'
import type { AllowedWebOrigins } from './security/web-origin-allowlist.js'
import type { WebAuthnCredentialStore } from './security/webauthn-credential-store.js'
import type { WorkspaceReplicaKeyStore } from './security/workspace-replica-key-store.js'
import type { WsTicketStore } from './security/ws-ticket-store.js'

interface LocalDaemonAppOptions {
  authMode: 'local-daemon'
  /** Document store/sync ports. When present, server-core's /api/v1
   *  HTTP surface (createServer(deps).app) is mounted behind the same
   *  /api/* auth as every other API route; when absent, /api/v1 stays
   *  unmounted (404). Optional so ad-hoc callers and legacy tests need no
   *  container. */
  serverDeps?: ServerDeps
  token?: string
  /**
   * RFC 9728 metadata for `/mcp`'s protected-resource discovery. The strategy
   * that CHECKS the credential is no longer injected — `createApp` builds it
   * over the one credential resolver, so there is no second place a secret is
   * compared.
   */
  mcpProtectedResourceMetadata?: McpProtectedResourceMetadataConfig
  /** Per-process-start identifier for /api/runtime/ping. Falls back to a
   *  fresh crypto.randomUUID() when omitted (tests, ad-hoc callers). */
  instanceId?: string
  touch: () => void
  getStatus: () => RuntimeStatusResponse
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
    /** Passkey pins paired origins registered (ADR-0039); durable like grants. */
    credentials: WebAuthnCredentialStore
  }
  /** The daemon's MemberProfile store (ADR-0041). When present alongside
   *  `pairing` and `serverDeps`, /api/workspaces/:workspaceId/members mounts
   *  and session-assert answers a real `profileId` for a pinned passkey that
   *  has been admitted to L1. Absent in ad-hoc/test callers, which get no
   *  membership surface and a session-assert `profileId` of null — the same
   *  answer S0-2 always gave. */
  members?: MemberProfileStore
  /** The read plane's workspace-key store (ADR-0042 decisions 1/3/5). When
   *  present alongside `pairing`, `members` and `serverDeps`,
   *  POST /api/workspaces/:workspaceId/replica-key mounts — same mount
   *  condition as the membership router, since a member's session is what
   *  this route hands the key to. Absent in ad-hoc/test callers, which get
   *  no replica-key surface at all. */
  replicaKeys?: WorkspaceReplicaKeyStore
  /** How long a `bounded`-tier lease lasts (replica-env.ts's
   *  WHITEBOARD_REPLICA_LEASE_TTL_MS). Only read when `replicaKeys` is
   *  present. Defaults to 7 days when both are supplied but this is not —
   *  ad-hoc/test callers that construct their own store typically pass this
   *  too. */
  replicaLeaseTtlMs?: number
  /** Daemon signing identity (security/daemon-identity.ts). Injectable for
   *  tests; when omitted, createApp loads-or-creates it from the data dir. */
  identity?: DaemonIdentity
  /** The macaroon chain's root key (ADR-0043 decision 4). When absent the
   *  `/api` guard carries no macaroon branch at all, so a daemon that mints
   *  none pays nothing — and a composition root that forgets to pass it
   *  silently refuses every macaroon, which is why `http-server.ts` supplies
   *  it rather than leaving each caller to remember. */
  macaroonRootKey?: Uint8Array
  /** This daemon's own bare origin (e.g. `http://127.0.0.1:3099`), threaded
   *  into wb_pairing_link_create so the tool embeds the daemon's real
   *  address instead of reading it from process.env. Absent in ad-hoc/test
   *  callers with no real listener — the tool still registers and answers
   *  isError, the same standalone behavior the stdio entrypoint gets. */
  daemonBaseUrl?: string
  /** Hands the composition root the checkpoint trigger the document router
   *  creates, so its shutdown can flush what an edit left pending. The
   *  checkpoint lands at a PAUSE in editing, so a shutdown that does not
   *  flush loses exactly the one the debounce exists to take. Called
   *  synchronously during createApp, so a root that arms its background work
   *  afterwards already holds it. */
  onAutoVersionTrigger?: (trigger: AutoVersionTrigger) => void
}

export interface ServerModeAppOptions {
  authMode: 'server-mode'
  /** See LocalDaemonAppOptions.identity. */
  identity?: DaemonIdentity
  /** Document store/sync ports. When present, server-core's /api/v1
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
  /** Hands the composition root the checkpoint trigger the document router
   *  creates, so its shutdown can flush what an edit left pending. The
   *  checkpoint lands at a PAUSE in editing, so a shutdown that does not
   *  flush loses exactly the one the debounce exists to take. Called
   *  synchronously during createApp, so a root that arms its background work
   *  afterwards already holds it. */
  onAutoVersionTrigger?: (trigger: AutoVersionTrigger) => void
  /** ADR-0046: sign-in through the configured external providers. Absent
   *  when none is configured, and then no `/auth/*` route exists. */
  signIn?: SignInRoutesDeps
  /** ADR-0046: resolve each request's person and gate every workspace on
   *  membership, members-only from the start. Absent (ad-hoc and older test
   *  compositions), the bearer's scopes alone decide. */
  people?: ServerModePeople
}

export type AppOptions = LocalDaemonAppOptions | ServerModeAppOptions
