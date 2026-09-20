import type { MembershipRefusalCode } from './api-contracts/membership.js'
import { membershipRefusalSchema } from './api-contracts/membership.js'
import type { ReplicaTier } from './api-contracts/replica-key.js'
import { replicaKeyResponseSchema } from './api-contracts/replica-key.js'
import { deriveDocumentKey } from './read-plane.js'
import { fromBase64 } from './sse-stream-hub.js'

/**
 * The read plane's in-memory session-key holder (ADR-0042 decisions 2/3/5,
 * ADR-0043 decision 3). The browser never persists a workspace content key
 * — this module holds raw key bytes only in a module-singleton Map, exposes
 * no serialisation of them, and forgets them on lapse or on `forget()`.
 * A future `tools/arch-lint` persisted-key scan should enforce that no
 * caller wires the bytes to a storage sink; until then, this module's job
 * is to never hand them anywhere but `replicaKeyProviderFor`'s derived,
 * non-extractable `CryptoKey`.
 *
 * Deliberately free of any node:* import and any DOM global — `fetch` and
 * passkey binding are injected via `ReplicaSource` so this module runs
 * unchanged in the browser and in a test.
 */

export type BindOutcome =
  | { ok: true }
  | { ok: false; reason: 'no-passkey' | 'cancelled' | 'rejected' | 'unreachable' }

export interface ReplicaSource {
  fetch: typeof fetch
  bindSession: () => Promise<BindOutcome>
}

export type SessionKeyResult =
  | {
      kind: 'key'
      workspaceKey: Uint8Array<ArrayBuffer>
      workspaceKeySalt: Uint8Array<ArrayBuffer>
      tier: ReplicaTier
      leaseExpiresAt?: number
    }
  | { kind: 'withheld'; reason: MembershipRefusalCode | 'unreachable' | 'lapsed' }

// Module-singleton: one shared entry and one shared in-flight request per
// (daemonBaseUrl, workspaceId), so every caller in a tab awaits the same
// request instead of minting N of them.
const cache = new Map<string, SessionKeyResult>()
const inFlight = new Map<string, Promise<SessionKeyResult>>()

function cacheKey(daemonBaseUrl: string, workspaceId: string): string {
  return `${daemonBaseUrl}\u0000${workspaceId}`
}

// Unpadded, which `atob` accepts; the schema pins both lengths to 43/22 chars.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  return fromBase64(value.replace(/-/g, '+').replace(/_/g, '/'))
}

async function fetchSessionKey(
  daemonBaseUrl: string,
  workspaceId: string,
  source: ReplicaSource,
): Promise<SessionKeyResult> {
  let response: Response
  let body: unknown
  try {
    response = await source.fetch(
      `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/replica-key`,
      { method: 'POST' },
    )
    body = await response.json()
  } catch {
    return { kind: 'withheld', reason: 'unreachable' }
  }

  if (response.ok) {
    const parsed = replicaKeyResponseSchema.safeParse(body)
    if (!parsed.success) {
      return { kind: 'withheld', reason: 'unreachable' }
    }
    return {
      kind: 'key',
      workspaceKey: base64UrlToBytes(parsed.data.workspaceKey),
      workspaceKeySalt: base64UrlToBytes(parsed.data.workspaceKeySalt),
      tier: parsed.data.tier,
      leaseExpiresAt:
        parsed.data.leaseExpiresAt === undefined
          ? undefined
          : Date.parse(parsed.data.leaseExpiresAt),
    }
  }

  const refusal = membershipRefusalSchema.safeParse(body)
  if (!refusal.success) {
    return { kind: 'withheld', reason: 'unreachable' }
  }
  return { kind: 'withheld', reason: refusal.data.error }
}

async function requestSessionKey(
  daemonBaseUrl: string,
  workspaceId: string,
  source: ReplicaSource,
): Promise<SessionKeyResult> {
  const result = await fetchSessionKey(daemonBaseUrl, workspaceId, source)
  if (result.kind === 'withheld' && result.reason === 'requires_person_session') {
    const bindOutcome = await source.bindSession()
    if (!bindOutcome.ok) {
      return result
    }
    return fetchSessionKey(daemonBaseUrl, workspaceId, source)
  }
  return result
}

/**
 * Answers this session's key for a (daemon, workspace) pair. A live cached
 * key answers immediately; a `bounded` lease past `leaseExpiresAt` is
 * checked on read, answers `withheld:'lapsed'` and drops the cached bytes.
 * With no `source`, an uncached pair answers `withheld:'unreachable'`
 * without being cached — there was no request to remember.
 */
export async function sessionKey(
  daemonBaseUrl: string,
  workspaceId: string,
  source?: ReplicaSource,
): Promise<SessionKeyResult> {
  const key = cacheKey(daemonBaseUrl, workspaceId)
  const cached = cache.get(key)
  if (cached !== undefined) {
    if (
      cached.kind === 'key' &&
      cached.leaseExpiresAt !== undefined &&
      Date.now() >= cached.leaseExpiresAt
    ) {
      // A lapsed lease's derived keys must go with it — otherwise a later
      // re-mint (once key rotation ships, with different bytes) would still
      // answer keyFor() from this memo, derived from the superseded key.
      cache.delete(key)
      derivedKeyMemo.delete(key)
      return { kind: 'withheld', reason: 'lapsed' }
    }
    return cached
  }

  if (source === undefined) {
    return { kind: 'withheld', reason: 'unreachable' }
  }

  const existing = inFlight.get(key)
  if (existing !== undefined) {
    return existing
  }

  // `promise` is read inside its own settlement handlers below. That is
  // safe — a `.then` handler only runs as a microtask, strictly after this
  // `const` has been assigned — and it is what lets each handler tell
  // whether it is still the CURRENT request for `key`: forget()/forgetAll()
  // may remove (or replace) this entry while the request is outstanding, and
  // a request that settles after that must not resurrect what was just
  // forgotten, nor leave a rejected request stuck in `inFlight` forever.
  const promise: Promise<SessionKeyResult> = requestSessionKey(
    daemonBaseUrl,
    workspaceId,
    source,
  ).then(
    (result) => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key)
        cache.set(key, result)
      }
      return result
    },
    (error: unknown) => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key)
      }
      throw error
    },
  )
  inFlight.set(key, promise)
  return promise
}

/** Drops the held key for one (daemon, workspace) pair — used on disconnect and reconnect. */
export function forget(daemonBaseUrl: string, workspaceId: string): void {
  const key = cacheKey(daemonBaseUrl, workspaceId)
  cache.delete(key)
  inFlight.delete(key)
  derivedKeyMemo.delete(key)
}

/** Drops every held key — used on logout. */
export function forgetAll(): void {
  cache.clear()
  inFlight.clear()
  derivedKeyMemo.clear()
}

export interface ReplicaKeyProvider {
  keyFor(documentId: string): Promise<{ key: CryptoKey; epoch: number } | 'withheld'>
}

// Non-extractable derived CryptoKeys, memoised per (daemon, workspace,
// documentId) so a repeat read is O(1) rather than a fresh HKDF derive.
// Cleared by forget()/forgetAll() alongside the session key they derive from.
const derivedKeyMemo = new Map<string, Map<string, CryptoKey>>()

// v1 derives every document at epoch 0 — a document's own epoch, once
// tracked, threads through the envelope it seals rather than this provider.
const EPOCH = 0

/** Builds the `ReplicaKeyProvider` `SealedDocumentStore` takes for a daemon-kept replica. */
export function replicaKeyProviderFor(
  daemonBaseUrl: string,
  workspaceId: string,
  source?: ReplicaSource,
): ReplicaKeyProvider {
  const key = cacheKey(daemonBaseUrl, workspaceId)
  return {
    async keyFor(documentId: string) {
      const result = await sessionKey(daemonBaseUrl, workspaceId, source)
      if (result.kind === 'withheld') {
        return 'withheld'
      }
      let perWorkspace = derivedKeyMemo.get(key)
      if (perWorkspace === undefined) {
        perWorkspace = new Map()
        derivedKeyMemo.set(key, perWorkspace)
      }
      const cachedDerived = perWorkspace.get(documentId)
      if (cachedDerived !== undefined) {
        return { key: cachedDerived, epoch: EPOCH }
      }
      const derived = await deriveDocumentKey({
        workspaceKey: result.workspaceKey,
        workspaceKeySalt: result.workspaceKeySalt,
        documentId,
        epoch: EPOCH,
      })
      perWorkspace.set(documentId, derived)
      return { key: derived, epoch: EPOCH }
    },
  }
}
