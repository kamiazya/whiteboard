/**
 * In-memory halves of the pairing-grant flow: single-use PKCE-bound auth
 * codes (60s) and origin-scoped session tokens (24h). Both die with the
 * process by design — a daemon restart is a global session kill, and the
 * durable half (which ORIGINS are trusted) lives in pairing-grant-store.ts.
 *
 * `requestState`-style tamper concerns don't apply here: the code is an
 * opaque random handle looked up server-side, never a value the client can
 * meaningfully alter, and PKCE (S256) binds redemption to the transaction
 * that started on the hosted origin.
 */
import { webcrypto } from 'node:crypto'
import { nanoid } from 'nanoid'

const CODE_TTL_MS = 60_000
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export async function computeS256Challenge(codeVerifier: string): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return Buffer.from(digest).toString('base64url')
}

interface PendingCode {
  readonly origin: string
  readonly codeChallenge: string
  readonly expiresAtMs: number
}

export interface PairingCodeStore {
  mint(input: { origin: string; codeChallenge: string }): string
  /** Single-use: any redemption attempt (right or wrong verifier) burns the
   *  code, so an attacker who observed it gets no second guess. */
  redeem(code: string, codeVerifier: string): Promise<{ origin: string } | null>
}

export function createPairingCodeStore({ ttlMs = CODE_TTL_MS }: { ttlMs?: number } = {}) {
  const pending = new Map<string, PendingCode>()
  const store: PairingCodeStore = {
    mint({ origin, codeChallenge }) {
      const code = nanoid(32)
      pending.set(code, { origin, codeChallenge, expiresAtMs: Date.now() + ttlMs })
      return code
    },
    async redeem(code, codeVerifier) {
      const entry = pending.get(code)
      if (!entry) return null
      pending.delete(code)
      if (Date.now() > entry.expiresAtMs) return null
      const challenge = await computeS256Challenge(codeVerifier)
      if (challenge !== entry.codeChallenge) return null
      return { origin: entry.origin }
    },
  }
  return store
}

interface SessionToken {
  readonly origin: string
  readonly expiresAtMs: number
}

export interface PairingTokenStore {
  mint(origin: string): { token: string; expiresAt: string }
  /** Tokens are origin-scoped: a valid token presented alongside a
   *  DIFFERENT origin fails — defense in depth on top of CORS. */
  validate(token: string, origin: string): boolean
  revokeOrigin(origin: string): void
}

export function createPairingTokenStore({ ttlMs = TOKEN_TTL_MS }: { ttlMs?: number } = {}) {
  const tokens = new Map<string, SessionToken>()
  const store: PairingTokenStore = {
    mint(origin) {
      const token = nanoid(48)
      const expiresAtMs = Date.now() + ttlMs
      tokens.set(token, { origin, expiresAtMs })
      return { token, expiresAt: new Date(expiresAtMs).toISOString() }
    },
    validate(token, origin) {
      const entry = tokens.get(token)
      if (!entry) return false
      if (Date.now() > entry.expiresAtMs) {
        tokens.delete(token)
        return false
      }
      return entry.origin === origin
    },
    revokeOrigin(origin) {
      for (const [token, entry] of tokens) {
        if (entry.origin === origin) tokens.delete(token)
      }
    },
  }
  return store
}
