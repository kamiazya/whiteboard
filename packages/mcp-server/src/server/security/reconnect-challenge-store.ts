// One-time, expiring nonce challenges for the WebCrypto keypair reconnect
// flow (see docs/how-to/connect-to-local-daemon.md). A client with an
// enrolled ECDSA P-256 keypair signs the minted nonce to prove possession of
// the private key without ever sending a long-lived secret over the wire.
//
// Unlike ws-ticket-store.ts (whose growth is bounded only by lazy expiry
// because it sits behind an already-authenticated OAuth grant), this store
// backs a PUBLIC, unauthenticated endpoint (`POST /api/reconnect-challenge`
// must mint regardless of enrollment, to avoid an enrollment oracle). Lazy
// expiry alone would let an attacker grow the map without bound within the
// TTL window, so a hard cap on unexpired entries is enforced at mint time.
//
// Threat model: this daemon binds to loopback by default, so flooding this
// endpoint requires local code-execution access — at which point an
// attacker already has far cheaper ways to disrupt the daemon than this
// specific 429. A single process-wide cap (reject-at-cap, no per-IP rate
// limiting) is accepted as sufficient for that threat model rather than
// adding IP-scoped throttling this codebase has no other precedent for.
// This assumption does NOT hold once a daemon is reachable from a hosted
// origin over the network (server-mode exposure) — see
// tmp/issues/server-mode-passkey-authn.md for the redesign that surface
// requires before this cap is a sufficient mitigation there too.

import { randomBytes } from 'node:crypto'

// Long enough for a page load to request a challenge and immediately sign
// it (sub-second in practice); short enough that a captured challengeId is
// useless well before a human could act on it.
const CHALLENGE_TTL_MS = 60_000

// Bounds memory for a long-lived daemon under flood from the public mint
// endpoint. Sized well above any plausible legitimate multi-tab burst.
const DEFAULT_MAX_PENDING_CHALLENGES = 256

interface ChallengeRecord {
  origin: string
  nonce: string
  expiresAt: number
}

interface MintedReconnectChallenge {
  challengeId: string
  nonce: string
  expiresIn: number
}

export interface ReconnectChallengeStore {
  // Mints an opaque, single-use challenge bound to the presented origin.
  // Returns null when the store is at its unexpired-entry cap — callers map
  // that to a 429-style rejection rather than unbounded growth.
  mintChallenge(origin: string): MintedReconnectChallenge | null
  // Redeems a challenge exactly once. Returns null for anything unknown,
  // expired, already-redeemed, or bound to a different origin than the one
  // presented at redemption time.
  redeemChallenge(challengeId: string, origin: string): string | null
  // Live entry count, for the same "is this leaking memory" observability
  // ws-ticket-store.ts exposes via size().
  size(): number
}

export function createReconnectChallengeStore(options?: {
  now?: () => number
  maxPending?: number
}): ReconnectChallengeStore {
  const now = options?.now ?? Date.now
  const maxPending = options?.maxPending ?? DEFAULT_MAX_PENDING_CHALLENGES
  const challenges = new Map<string, ChallengeRecord>()

  // Lazy sweep on every mint, not a timer — a `setInterval` would keep this
  // daemon's event loop alive for its whole lifetime. A challenge past its
  // TTL is already unredeemable (redeemChallenge re-checks expiresAt), so
  // dropping it here is a memory concern only — except that the hard cap
  // below depends on this sweep running first so legitimate mints can
  // resume once flood traffic ages out.
  function pruneExpired(): void {
    const cutoff = now()
    for (const [id, record] of challenges) {
      if (record.expiresAt >= cutoff) continue
      challenges.delete(id)
    }
  }

  function mintChallenge(origin: string): MintedReconnectChallenge | null {
    pruneExpired()
    if (challenges.size >= maxPending) return null

    const challengeId = randomBytes(16).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const expiresAt = now() + CHALLENGE_TTL_MS
    challenges.set(challengeId, { origin, nonce, expiresAt })
    return { challengeId, nonce, expiresIn: CHALLENGE_TTL_MS / 1000 }
  }

  function redeemChallenge(challengeId: string, origin: string): string | null {
    const record = challenges.get(challengeId)
    if (!record) return null

    if (record.expiresAt < now()) {
      // Actually expired: safe to reclaim the slot regardless of which
      // origin is asking.
      challenges.delete(challengeId)
      return null
    }

    // A wrong-origin guess must not consume the legitimate holder's
    // still-valid challenge — leave it in the map so the real client can
    // still redeem it before the TTL expires.
    if (record.origin !== origin) return null

    // Delete-on-redeem: Node's run-to-completion semantics make this
    // atomic — two concurrent redemptions racing the same challengeId
    // cannot both win because whichever runs second finds the key gone.
    challenges.delete(challengeId)
    return record.nonce
  }

  function size(): number {
    return challenges.size
  }

  return { mintChallenge, redeemChallenge, size }
}
