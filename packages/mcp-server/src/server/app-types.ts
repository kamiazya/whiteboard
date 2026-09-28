import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { AutoVersionTrigger } from './routes/document.js'
import type { SignInRoutesDeps } from './routes/sign-in.js'
import type { DaemonIdentity } from './security/daemon-identity.js'
import type { McpProtectedResourceMetadataConfig } from './security/mcp-auth.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import type { ServerModePeople } from './security/server-mode-middleware.js'
import type { WorkspaceReplicaKeyStore } from './security/workspace-replica-key-store.js'

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
  /** The read plane's workspace-key store (ADR-0042 decisions 1/3/5). With
   *  `serverDeps`, POST /api/workspaces/:workspaceId/replica-key mounts.
   *  Absent in ad-hoc/test callers, which get no replica-key surface. */
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
