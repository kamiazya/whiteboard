import type { MembershipRefusalCode } from './api-contracts/membership.js'
import { membershipRefusalSchema } from './api-contracts/membership.js'
import type { ReplicaTier } from './api-contracts/replica-key.js'
import { replicaKeyResponseSchema } from './api-contracts/replica-key.js'
import { deriveDocumentKey } from './read-plane.js'

/**
 * The read plane's in-memory session-key holder (ADR-0042 decisions 2/3/5,
 * ADR-0043 decision 3). The browser never persists a workspace content key
 * — this module holds raw key bytes only in a module-singleton Map, exposes
 * no serialisation of them, and forgets them on lapse or on `forget()`.
 * `tools/arch-lint`'s persisted-key scan is what enforces that no future
 * caller wires the bytes to a storage sink; this module's job is to never
 * hand them anywhere but `replicaKeyProviderFor`'s derived, non-extractable
 * `CryptoKey`.
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

interface CacheEntry {
  result: SessionKeyResult
  leaseExpiresAtMs?: number
}

// Module-singleton: one shared entry and one shared in-flight request per
// (daemonBaseUrl, workspaceId), so every caller in a tab awaits the same
// request instead of minting N of them.
const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<SessionKeyResult>>()

function cacheKey(daemonBaseUrl: string, workspaceId: string): string {
  return `${daemonBaseUrl}\u0000${workspaceId}`
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + pad)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function fetchSessionKey(
  daemonBaseUrl: string,
  workspaceId: string,
  source: ReplicaSource,
): Promise<SessionKeyResult> {
  let response: Response
  try {
    response = await source.fetch(
      `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/replica-key`,
      { method: 'POST' },
    )
  } catch {
    return { kind: 'withheld', reason: 'unreachable' }
  }

  let body: unknown
  try {
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
    if (cached.leaseExpiresAtMs !== undefined && Date.now() >= cached.leaseExpiresAtMs) {
      cache.delete(key)
      return { kind: 'withheld', reason: 'lapsed' }
    }
    return cached.result
  }

  if (source === undefined) {
    return { kind: 'withheld', reason: 'unreachable' }
  }

  const existing = inFlight.get(key)
  if (existing !== undefined) {
    return existing
  }

  const promise = requestSessionKey(daemonBaseUrl, workspaceId, source).then((result) => {
    inFlight.delete(key)
    cache.set(key, {
      result,
      leaseExpiresAtMs: result.kind === 'key' ? result.leaseExpiresAt : undefined,
    })
    return result
  })
  inFlight.set(key, promise)
  return promise
}

/** Drops the held key for one (daemon, workspace) pair — used on disconnect and reconnect. */
export function forget(daemonBaseUrl: string, workspaceId: string): void {
  cache.delete(cacheKey(daemonBaseUrl, workspaceId))
  clearDerivedKeyMemo(cacheKey(daemonBaseUrl, workspaceId))
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

function clearDerivedKeyMemo(key: string): void {
  derivedKeyMemo.delete(key)
}

/**
 * Builds the `ReplicaKeyProvider` `SealedDocumentStore` takes for a
 * daemon-kept replica. v1 derives every document at epoch 0 — a document's
 * own epoch, once tracked, threads through the envelope it seals rather
 * than through this provider.
 */
export function replicaKeyProviderFor(
  daemonBaseUrl: string,
  workspaceId: string,
  source?: ReplicaSource,
): ReplicaKeyProvider {
  const key = cacheKey(daemonBaseUrl, workspaceId)
  const EPOCH = 0
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
