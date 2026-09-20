/**
 * In-memory halves of the pairing-grant flow: single-use PKCE-bound auth
 * codes (60s), origin-scoped session tokens (24h), and single-use session
 * challenges (60s). All three die with the process by design — a daemon
 * restart is a global session kill, and the durable half (which ORIGINS are
 * trusted) lives in pairing-grant-store.ts.
 *
 * `requestState`-style tamper concerns don't apply here: the code is an
 * opaque random handle looked up server-side, never a value the client can
 * meaningfully alter, and PKCE (S256) binds redemption to the transaction
 * that started on the hosted origin.
 *
 * A session token also carries an optional passkey BINDING (ADR-0041 S0-2):
 * a browser session becomes a person's session only once it presents a
 * WebAuthn assertion over a challenge minted here, verified against a passkey
 * the daemon has pinned. The binding lives and dies with the token — never
 * persisted, same as the token itself — and `revokeBoundTo` is the
 * synchronous kill a later credential/membership revocation calls.
 */
import { webcrypto } from 'node:crypto'
import { nanoid } from 'nanoid'

const CODE_TTL_MS = 60_000
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const CHALLENGE_TTL_MS = 60_000

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

/** A session becomes a person's session by asserting this pinned passkey
 *  over a daemon-minted challenge (ADR-0041 S0-2). Identifies the credential
 *  a session is bound to, never the person — mapping to a MemberProfile is
 *  S0-4's job. */
export interface PasskeyBinding {
  readonly origin: string
  readonly credentialId: string
}

interface SessionToken {
  readonly origin: string
  readonly expiresAtMs: number
  readonly binding?: PasskeyBinding
}

export interface PairingTokenStore {
  mint(origin: string): { token: string; expiresAt: string }
  /** Tokens are origin-scoped: a valid token presented alongside a
   *  DIFFERENT origin fails — defense in depth on top of CORS. */
  validate(token: string, origin: string): boolean
  revokeOrigin(origin: string): void
  /** Binds a passkey to a valid, unexpired token. Null (and no bind) for an
   *  unknown or expired one. Answers the token's own expiry rather than a
   *  boolean because the session-assert route reports it as `boundUntil` —
   *  a binding never outlives the token that carries it. */
  bind(token: string, binding: PasskeyBinding): { expiresAt: string } | null
  /** The binding of a valid token for that origin, or null when the token is
   *  invalid for that origin, or unbound. */
  bindingOf(token: string, origin: string): PasskeyBinding | null
  /** Kills every token bound to one of the given (origin, credentialId)
   *  pairs — the synchronous L1 kill a credential/membership revocation
   *  calls. Returns how many died. Unbound tokens are untouched. */
  revokeBoundTo(credentials: readonly PasskeyBinding[]): number
}

export function createPairingTokenStore({ ttlMs = TOKEN_TTL_MS }: { ttlMs?: number } = {}) {
  const tokens = new Map<string, SessionToken>()
  const live = (token: string): SessionToken | null => {
    const entry = tokens.get(token)
    if (!entry) return null
    if (Date.now() > entry.expiresAtMs) {
      tokens.delete(token)
      return null
    }
    return entry
  }
  const store: PairingTokenStore = {
    mint(origin) {
      const token = nanoid(48)
      const expiresAtMs = Date.now() + ttlMs
      tokens.set(token, { origin, expiresAtMs })
      return { token, expiresAt: new Date(expiresAtMs).toISOString() }
    },
    validate(token, origin) {
      const entry = live(token)
      return entry !== null && entry.origin === origin
    },
    revokeOrigin(origin) {
      for (const [token, entry] of tokens) {
        if (entry.origin === origin) tokens.delete(token)
      }
    },
    bind(token, binding) {
      const entry = live(token)
      if (entry === null) return null
      tokens.set(token, { ...entry, binding })
      return { expiresAt: new Date(entry.expiresAtMs).toISOString() }
    },
    bindingOf(token, origin) {
      const entry = live(token)
      if (entry === null || entry.origin !== origin) return null
      return entry.binding ?? null
    },
    revokeBoundTo(credentials) {
      let count = 0
      for (const [token, entry] of tokens) {
        if (entry.binding === undefined) continue
        const matches = credentials.some(
          (c) =>
            c.origin === entry.binding?.origin && c.credentialId === entry.binding?.credentialId,
        )
        if (matches) {
          tokens.delete(token)
          count++
        }
      }
      return count
    },
  }
  return store
}

interface PendingChallenge {
  readonly nonce: Uint8Array
  readonly expiresAtMs: number
}

export interface SessionChallengeStore {
  /** One live challenge per token: a second mint replaces the first. */
  mint(token: string): { challenge: string; expiresAt: string }
  /** Single-use: burned on any redemption attempt, right token or wrong. */
  redeem(token: string): Uint8Array | null
}

export function createSessionChallengeStore({
  ttlMs = CHALLENGE_TTL_MS,
}: {
  ttlMs?: number
} = {}): SessionChallengeStore {
  const pending = new Map<string, PendingChallenge>()
  return {
    mint(token) {
      const nonce = webcrypto.getRandomValues(new Uint8Array(32))
      const expiresAtMs = Date.now() + ttlMs
      pending.set(token, { nonce, expiresAtMs })
      return {
        challenge: Buffer.from(nonce).toString('base64url'),
        expiresAt: new Date(expiresAtMs).toISOString(),
      }
    },
    redeem(token) {
      const entry = pending.get(token)
      if (!entry) return null
      pending.delete(token)
      if (Date.now() > entry.expiresAtMs) return null
      return entry.nonce
    },
  }
}
