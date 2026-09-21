/**
 * The ONE `DocumentStore` factory (ADR-0042/0043 S4b). Every production
 * construction of `IdbDocumentStore` goes through `openDocumentStore` —
 * enforced by `replica-key-holder-seam.test.ts`'s source scan — so a
 * daemon-kept workspace's replica is sealed under the session key and a
 * browser-kept workspace (or any single document) stays the bare bytes an
 * `IdbDocumentStore` always wrote.
 *
 * The unit this seals is the WORKSPACE RECORD (`workspace-tree:<id>`), not a
 * single document — per-document splitting is explicitly not near-term, and
 * the routing below reflects that: every `document:*` ref is plaintext
 * regardless of which workspace it belongs to.
 *
 * Only this module imports `sessionKey`/`replicaKeyProviderFor` from the
 * daemon-client session-key holder — a second importer would be a second
 * place deciding sealed-vs-plaintext, which is exactly what the ONE factory
 * exists to rule out (`replica-key-holder-seam.test.ts`).
 */
import type {
  ReplicaSource,
  SessionKeyStatus,
} from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  forget,
  replicaKeyProviderFor,
  sessionKeyStatus,
} from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import type { DocumentStore } from '@kamiazya/whiteboard-ports'
import { getAppLogger } from './app-logger.js'
import { createDaemonFetch } from './daemon-auth-fetch.js'
import { IdbDocumentStore } from './idb-document-store.js'
import type { PasskeyCredentials } from './passkey-attestation.js'
import { bindPasskeySession } from './passkey-session.js'
import { rememberReplicaKey } from './replica-unlock.js'
import type { ReplicaKeyProvider } from './sealed-document-store.js'
import { SealedDocumentStore } from './sealed-document-store.js'
import { createUserSettingsStore } from './user-settings-store.js'

const log = getAppLogger('replica-store')

const WORKSPACE_TREE_REF = /^workspace-tree:(.+)$/

interface ConnectedKeeper {
  baseUrl: string
  token: string | null
  /** The wrapped, authorized fetch — named `daemonFetch` for `keeper-parity.test.ts`'s scan. */
  daemonFetch: typeof globalThis.fetch
  credentials?: PasskeyCredentials
  /**
   * The key material the session bind's assertion produced, once it has.
   * Held per CONNECTION rather than in a module map, so a reconnect or a
   * disconnect drops it with everything else that session knew — the bytes
   * are the one thing that could open every replica of this daemon.
   */
  prfOutput?: Uint8Array<ArrayBuffer>
}

/** Module state: the daemon App is currently connected to, or none. */
let connected: ConnectedKeeper | null = null

/** Workspaces marked as a replica of some daemon before the registry entry lands (see `markReplica`). */
const pending = new Map<string, string>()

/** The daemon a workspace's replica belongs to, from the in-memory mark or the persisted registry. */
function replicaDaemonBaseUrl(workspaceId: string): string | undefined {
  const marked = pending.get(workspaceId)
  if (marked !== undefined) return marked
  return createUserSettingsStore().load().storage.replicas?.[workspaceId]?.daemonBaseUrl
}

/**
 * A `ReplicaSource` only when the replica's own daemon is the one this tab
 * is connected to.
 *
 * Its `onKeyResponse` is where a cold start is PAID FOR (ADR-0042 decision
 * 6): the session bind's own assertion already produced the wrapping
 * material, so a key the daemon mints is wrapped and left beside the replica
 * without anyone being prompted a second time. With no prf output held —
 * an authenticator that ignores the extension, or a session that was
 * already bound and so performed no gesture this tab — nothing is written,
 * and the replica behaves exactly as it did before this existed.
 *
 * Failure is swallowed on purpose. Remembering is an OPTIMISATION for the
 * next tab; a workspace that just opened must not fail because a
 * localStorage write did.
 */
function sourceFor(daemonBaseUrl: string, workspaceId: string): ReplicaSource | undefined {
  if (connected === null || connected.baseUrl !== daemonBaseUrl) return undefined
  const keeper = connected
  const { daemonFetch, credentials } = keeper
  return {
    fetch: daemonFetch,
    bindSession: async () => {
      const outcome = await bindPasskeySession({ daemonBaseUrl, fetch: daemonFetch, credentials })
      // Only onto the connection this bind belongs to: a disconnect or a
      // reconnect mid-bind replaced `connected`, and the new one never
      // performed this gesture.
      if (outcome.ok && outcome.prfOutput !== undefined && connected === keeper) {
        keeper.prfOutput = outcome.prfOutput
      }
      return outcome
    },
    onKeyResponse: (response) => {
      const prfOutput = keeper.prfOutput
      if (prfOutput === undefined || connected !== keeper) return
      void rememberReplicaKey({ daemonBaseUrl, workspaceId, response, prfOutput }).catch(
        (error: unknown) => {
          log.info('a replica key could not be remembered for a cold start', error)
        },
      )
    },
  }
}

const routingProvider: ReplicaKeyProvider = {
  async keyFor(documentId) {
    const match = WORKSPACE_TREE_REF.exec(documentId)
    if (match === null) return 'plaintext'
    const workspaceId = match[1] as string
    const daemonBaseUrl = replicaDaemonBaseUrl(workspaceId)
    if (daemonBaseUrl === undefined) return 'plaintext'
    return replicaKeyProviderFor(
      daemonBaseUrl,
      workspaceId,
      sourceFor(daemonBaseUrl, workspaceId),
    ).keyFor(documentId)
  },
}

/**
 * The S4a holder's cached answer for one workspace's replica key — no
 * request, no key bytes — for a reader that only needs to know whether a
 * daemon-kept replica is readable right now and why not (ADR-0042 decision
 * 4/5's degraded read-plane states). `undefined` both before any ask and
 * for a workspace this build never marked/registered as a replica: neither
 * is this module's routing decision to make, since `sealed-document-store.ts`
 * stays ignorant of membership vocabulary and only ever sees the provider's
 * `keyFor` answer.
 */
export function replicaKeyStatus(
  daemonBaseUrl: string,
  workspaceId: string,
): SessionKeyStatus | undefined {
  return sessionKeyStatus(daemonBaseUrl, workspaceId)
}

/**
 * The one `DocumentStore` construction site. `dbName` mirrors
 * `IdbDocumentStore`'s own optional parameter — production never passes it;
 * a test claims a private database the way every other browser test does.
 */
export function openDocumentStore(dbName?: string): DocumentStore {
  return new SealedDocumentStore(new IdbDocumentStore(dbName), routingProvider)
}

/**
 * Tells `openDocumentStore` which daemon this tab is connected to, so a
 * replica routes to a real `ReplicaSource` instead of the withheld answer an
 * absent one gets. `null` disconnects. A change of `baseUrl`/`token` (a
 * reconnect, or a token rotation) forgets whatever keys the PREVIOUS
 * connection held — a stale key must not keep answering after the session
 * that minted it is gone.
 */
export function connectReplicaKeeper(
  daemon: {
    baseUrl: string
    token: string | null
    fetch?: typeof globalThis.fetch
    credentials?: PasskeyCredentials
  } | null,
): void {
  const previous = connected
  connected =
    daemon === null
      ? null
      : {
          baseUrl: daemon.baseUrl,
          token: daemon.token,
          daemonFetch: createDaemonFetch(
            daemon.baseUrl,
            () => daemon.token ?? undefined,
            daemon.fetch ?? fetch,
          ),
          credentials: daemon.credentials,
        }
  const changed =
    previous !== null &&
    (daemon === null || previous.baseUrl !== daemon.baseUrl || previous.token !== daemon.token)
  if (changed) forgetDaemonKeys(previous.baseUrl)
}

/** Marks a workspace as a replica of `daemonBaseUrl` BEFORE its first pull is saved, so the pull is sealed even though the registry entry does not exist yet. */
export function markReplica(workspaceId: string, daemonBaseUrl: string): void {
  pending.set(workspaceId, daemonBaseUrl)
}

/**
 * "Stop using this daemon" from Settings. Drops the connection SYNCHRONOUSLY
 * when it is the one being disconnected, then forgets its keys — App's own
 * `connectReplicaKeeper(null)` follows on the next render, but a load in
 * that window would otherwise still find `connected` and mint a fresh key
 * through the old session. A different daemon's connection is untouched.
 */
export function disconnectReplicaKeeper(daemonBaseUrl: string): void {
  if (connected?.baseUrl === daemonBaseUrl) connected = null
  forgetDaemonKeys(daemonBaseUrl)
}

/** Forgets every held key for `daemonBaseUrl` — used on disconnect and on a reconnect that changes identity. */
export function forgetDaemonKeys(daemonBaseUrl: string): void {
  for (const [workspaceId, markedBaseUrl] of pending) {
    if (markedBaseUrl === daemonBaseUrl) forget(daemonBaseUrl, workspaceId)
  }
  const registry = createUserSettingsStore().load().storage.replicas ?? {}
  for (const [workspaceId, entry] of Object.entries(registry)) {
    if (entry.daemonBaseUrl === daemonBaseUrl) forget(daemonBaseUrl, workspaceId)
  }
}
