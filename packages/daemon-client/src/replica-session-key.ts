import type { z } from 'zod'
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
  | {
      ok: true
      /**
       * The key material the binding assertion carried, when the
       * authenticator produced it (ADR-0042 decision 6). The SAME gesture
       * that proves who is asking is the one that yields this, so a cold
       * start costs no second prompt.
       *
       * Absent is ORDINARY: prf support is broad and not universal, and
       * the session is bound either way — only the cold start is lost.
       */
      prfOutput?: Uint8Array<ArrayBuffer>
    }
  | { ok: false; reason: 'no-passkey' | 'cancelled' | 'rejected' | 'unreachable' }

export interface ReplicaSource {
  fetch: typeof fetch
  bindSession: () => Promise<BindOutcome>
  /**
   * Called with each response the daemon MINTS, so a caller can wrap and
   * persist it for a cold start (ADR-0042 decision 6). The parsed response
   * rather than the decoded bytes: a cold start rebuilds this holder's
   * state through `adoptSessionKey`, which takes the same shape, so there
   * is never a second hand-written idea of what a replica key is.
   *
   * Not called for a withheld answer — there is nothing to keep.
   */
  onKeyResponse?: (response: ReplicaKeyResponse) => void
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

/** The reason a workspace's key is withheld — `SessionKeyResult`'s own union, named for callers that only care about that arm. */
export type WithheldReason = Extract<SessionKeyResult, { kind: 'withheld' }>['reason']

/** `sessionKeyStatus`'s answer — the holder's cached state without the key bytes, for a caller that only needs to know WHY, not to read. */
export type SessionKeyStatus =
  | { kind: 'held'; tier: ReplicaTier; leaseExpiresAt?: number }
  | { kind: 'withheld'; reason: WithheldReason }

// Module-singleton: one shared entry and one shared in-flight request per
// (daemonBaseUrl, workspaceId), so every caller in a tab awaits the same
// request instead of minting N of them.
const cache = new Map<string, SessionKeyResult>()
const inFlight = new Map<string, Promise<SessionKeyResult>>()

function cacheKey(daemonBaseUrl: string, workspaceId: string): string {
  return `${daemonBaseUrl}\u0000${workspaceId}`
}

/** True for a cached `'key'` entry whose bounded lease has passed — the one check `sessionKey` and `sessionKeyStatus` must never disagree on. */
function lapsed(entry: SessionKeyResult): boolean {
  return (
    entry.kind === 'key' && entry.leaseExpiresAt !== undefined && Date.now() >= entry.leaseExpiresAt
  )
}

/**
 * How long a cached `'unreachable'` stands before the holder will ask again.
 *
 * `unreachable` is the ONE withheld reason that is not a decision — the
 * daemon said nothing, so nothing about this browser's standing changed.
 * Cached forever (which it was) a transient blip kept a replica locked until
 * the person pressed Reconnect, long after the daemon came back. Not cached
 * at all it would re-request on every read, which is the request-storm shape
 * this repo has already paid for once.
 *
 * So: cached, and self-healing within this window. An authoritative refusal
 * — `not_a_member`, `requires_person_session`, `lapsed` — keeps caching
 * until something forgets it, because those ARE decisions.
 */
const UNREACHABLE_TTL_MS = 30_000

/** When each cached `'unreachable'` was recorded, so it can go stale. */
const unreachableAt = new Map<string, number>()

/** True for a cached `'unreachable'` old enough to be worth re-asking — shared by `sessionKey` and `sessionKeyStatus` for the reason `lapsed` is. */
function staleUnreachable(entry: SessionKeyResult, key: string): boolean {
  if (entry.kind !== 'withheld' || entry.reason !== 'unreachable') return false
  const recordedAt = unreachableAt.get(key)
  return recordedAt === undefined || Date.now() - recordedAt >= UNREACHABLE_TTL_MS
}

// Unpadded, which `atob` accepts; the schema pins both lengths to 43/22 chars.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  return fromBase64(value.replace(/-/g, '+').replace(/_/g, '/'))
}

/** What `/replica-key` answers, parsed — the shape a cold start wraps and adopts. */
export type ReplicaKeyResponse = z.infer<typeof replicaKeyResponseSchema>

/**
 * The ONE conversion from a parsed response to what the holder keeps.
 * `fetchSessionKey` and `adoptSessionKey` both go through it, so a replica
 * restored from disk and one just fetched cannot be two different states.
 */
function heldFrom(response: ReplicaKeyResponse): Extract<SessionKeyResult, { kind: 'key' }> {
  return {
    kind: 'key',
    workspaceKey: base64UrlToBytes(response.workspaceKey),
    workspaceKeySalt: base64UrlToBytes(response.workspaceKeySalt),
    tier: response.tier,
    leaseExpiresAt:
      response.leaseExpiresAt === undefined ? undefined : Date.parse(response.leaseExpiresAt),
  }
}

/**
 * Holds a key somebody else unwrapped, as if this session had fetched it.
 *
 * Answers whether it was taken. It is REFUSED in two cases, each because
 * taking it would be worse than not having it: a lease that has already
 * passed would hold bytes every read then rejects, and a pair this session
 * already holds a key for outranks a blob from disk, which may be older
 * than the live session that minted the held one.
 */
export function adoptSessionKey(
  daemonBaseUrl: string,
  workspaceId: string,
  response: ReplicaKeyResponse,
): boolean {
  const key = cacheKey(daemonBaseUrl, workspaceId)
  const held = heldFrom(response)
  if (lapsed(held)) return false
  const existing = cache.get(key)
  if (existing !== undefined && existing.kind === 'key' && !lapsed(existing)) return false
  cache.set(key, held)
  unreachableAt.delete(key)
  derivedKeyMemo.delete(key)
  return true
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
    source.onKeyResponse?.(parsed.data)
    return heldFrom(parsed.data)
  }

  const refusal = membershipRefusalSchema.safeParse(body)
  if (!refusal.success) {
    return { kind: 'withheld', reason: 'unreachable' }
  }
  return { kind: 'withheld', reason: refusal.data.error }
}

/**
 * What the cache can answer for `key` on its own, or null to go and ask.
 *
 * Both expiries PURGE rather than merely hiding, and each for its own
 * reason. A lapsed lease's derived keys have to go with it, or a later
 * re-mint with different bytes would still be answered from the memo. A
 * stale `unreachable` is dropped so that a caller with no source falls
 * through to a fresh `unreachable` rather than replaying an expired one.
 */
function readCache(key: string): SessionKeyResult | null {
  const cached = cache.get(key)
  if (cached === undefined) return null
  if (lapsed(cached)) {
    cache.delete(key)
    derivedKeyMemo.delete(key)
    return { kind: 'withheld', reason: 'lapsed' }
  }
  if (staleUnreachable(cached, key)) {
    cache.delete(key)
    unreachableAt.delete(key)
    return null
  }
  return cached
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
  const cached = readCache(key)
  if (cached !== null) return cached

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
        if (result.kind === 'withheld' && result.reason === 'unreachable') {
          unreachableAt.set(key, Date.now())
        } else {
          unreachableAt.delete(key)
        }
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

/**
 * Reads this session's CACHED answer for a (daemon, workspace) pair without
 * the key bytes and without triggering a request — for a caller that only
 * needs to know whether a document could be read right now, and why not
 * (ADR-0042 decision 4/5's degraded read-plane states). `undefined` means
 * nothing has been asked yet, which reads the same as `'unreachable'` to a
 * caller: neither one implies a request was ever made. Shares `lapsed()`
 * with `sessionKey` so the two can never disagree about a bounded lease —
 * a status read is otherwise side-effect-free, unlike `sessionKey`'s own
 * lapse check, which purges the cache entry it finds lapsed.
 */
export function sessionKeyStatus(
  daemonBaseUrl: string,
  workspaceId: string,
): SessionKeyStatus | undefined {
  const key = cacheKey(daemonBaseUrl, workspaceId)
  const cached = cache.get(key)
  if (cached === undefined) return undefined
  if (lapsed(cached)) return { kind: 'withheld', reason: 'lapsed' }
  // A stale `unreachable` reads as "nothing asked yet" rather than as a
  // standing refusal: the next `sessionKey` will ask, so a caller must not
  // paint it as a settled state.
  if (staleUnreachable(cached, key)) return undefined
  if (cached.kind === 'withheld') return cached
  return {
    kind: 'held',
    tier: cached.tier,
    ...(cached.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: cached.leaseExpiresAt }),
  }
}

/** Drops the held key for one (daemon, workspace) pair — used on disconnect and reconnect. */
export function forget(daemonBaseUrl: string, workspaceId: string): void {
  const key = cacheKey(daemonBaseUrl, workspaceId)
  cache.delete(key)
  inFlight.delete(key)
  derivedKeyMemo.delete(key)
  unreachableAt.delete(key)
}

/** Drops every held key — used on logout. */
export function forgetAll(): void {
  cache.clear()
  inFlight.clear()
  derivedKeyMemo.clear()
  unreachableAt.clear()
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
      const cachedDerived = derivedKeyMemo.get(key)?.get(documentId)
      if (cachedDerived !== undefined) {
        return { key: cachedDerived, epoch: EPOCH }
      }
      const derived = await deriveDocumentKey({
        workspaceKey: result.workspaceKey,
        workspaceKeySalt: result.workspaceKeySalt,
        documentId,
        epoch: EPOCH,
      })
      // forget()/forgetAll() may have run while the request or the derive
      // was outstanding. The entry this derive came from is then no longer
      // the held one, and memoising it would resurrect what was just
      // forgotten — so the answer is the same as if the key had never been
      // held, and the caller's next ask goes through a fresh request.
      if (cache.get(key) !== result) {
        return 'withheld'
      }
      let perWorkspace = derivedKeyMemo.get(key)
      if (perWorkspace === undefined) {
        perWorkspace = new Map()
        derivedKeyMemo.set(key, perWorkspace)
      }
      perWorkspace.set(documentId, derived)
      return { key: derived, epoch: EPOCH }
    },
  }
}
