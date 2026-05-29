// JWT access-token validator adapter for the OAuth resource-server seam.
//
// This module implements `OAuthResourceTokenValidator` using `jose` for JWT
// signature verification, claim validation, and algorithm policy enforcement.
// It does NOT perform JWKS discovery or network fetches — the `keyResolver`
// seam is the caller's responsibility. Tests use in-memory key pairs; a
// production deployment wires in a `jose` remote JWKS key set via
// `createRemoteJWKSet`.
//
// Algorithm policy:
//   - Default allowed algorithms: RS256, ES256.
//   - `alg: none` is always rejected — `none` is not in the allowed list, so
//     jose throws ERR_JOSE_ALG_NOT_ALLOWED / ERR_JOSE_NOT_SUPPORTED.
//   - HS256 and other symmetric algorithms are rejected unless the caller
//     explicitly adds them to `allowedAlgorithms`.
//
// Scope claim policy:
//   - Default claim: `scope` (space-delimited string, RFC 6749 §3.3).
//   - `scp` option: accepts string[] or space-delimited string.
//   - Unknown scope strings (not in AuthScope vocabulary) are silently
//     discarded. They cannot satisfy any AuthScope requirement.
//
// Failure mapping:
//   ERR_JWT_EXPIRED                        → expired
//   ERR_JWT_CLAIM_VALIDATION_FAILED iss    → invalid_issuer
//   ERR_JWT_CLAIM_VALIDATION_FAILED aud    → invalid_audience
//   ERR_JWT_CLAIM_VALIDATION_FAILED other  → malformed
//     (nbf-in-future falls here: neither `expired` nor `invalid_signature`
//     fits a token that is structurally valid but not yet active)
//   ERR_JWS_SIGNATURE_VERIFICATION_FAILED  → invalid_signature
//   ERR_JWS_INVALID (structural parse fail) → malformed
//   ERR_JOSE_ALG_NOT_ALLOWED               → invalid_signature
//   ERR_JOSE_NOT_SUPPORTED                 → invalid_signature
//   ERR_JWT_MALFORMED (and other JOSE err)  → malformed
//   keyResolver threw                      → validator_unavailable
//     (error message discarded — may contain IdP URLs, stack frames)
//
// Non-leak guarantee: no failure result field ever contains the raw JWT
// token, issuer URL, audience value, key IDs, or thrown error messages.
// The `reason` string alone reaches callers.

import {
  type CryptoKey,
  type JWTHeaderParameters,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose'
import type { AuthScope } from './auth-strategy.js'
import type {
  OAuthResourceTokenValidationInput,
  OAuthResourceTokenValidationResult,
  OAuthResourceTokenValidator,
} from './oauth-resource-strategy.js'

const KNOWN_AUTH_SCOPES = new Set<string>([
  'canvas:read',
  'canvas:write',
  'workspace:read',
  'workspace:write',
  'versions:read',
  'versions:write',
  'files:read',
  'files:write',
  'runtime:read',
  'runtime:admin',
  'mcp:call',
])

function isAuthScope(s: string): s is AuthScope {
  return KNOWN_AUTH_SCOPES.has(s)
}

function parseScopesClaim(
  payload: Record<string, unknown>,
  claim: 'scope' | 'scp',
): readonly AuthScope[] {
  const raw = payload[claim]
  let parts: string[]

  if (claim === 'scp' && Array.isArray(raw)) {
    parts = raw.filter((s): s is string => typeof s === 'string')
  } else if (typeof raw === 'string') {
    parts = raw.split(' ').filter(Boolean)
  } else {
    parts = []
  }

  return parts.filter(isAuthScope)
}

// Receives the JWT protectedHeader only — the raw token string is
// intentionally excluded so key-store implementations cannot accidentally
// log it.
// `CryptoKey` is the Web Crypto API key type supported by jose v6 across
// Node.js 18+ and browser runtimes. `Uint8Array` covers symmetric secrets.
export type JwtKeyResolver = (
  protectedHeader: JWTHeaderParameters,
) => Promise<CryptoKey | Uint8Array>

export interface OAuthJwtValidatorOptions {
  issuer: string
  audience: string | readonly string[]
  /** Tolerated clock drift in seconds. Default: 60. */
  clockSkewSeconds?: number
  /** JWT algorithms to accept. Default: ['RS256', 'ES256']. */
  allowedAlgorithms?: readonly string[]
  /** Which claim holds the granted scopes. Default: 'scope'. */
  scopeClaim?: 'scope' | 'scp'
  keyResolver: JwtKeyResolver
}

export function createOAuthJwtValidator(
  options: OAuthJwtValidatorOptions,
): OAuthResourceTokenValidator {
  const {
    issuer,
    audience,
    clockSkewSeconds = 60,
    allowedAlgorithms = ['RS256', 'ES256'],
    scopeClaim = 'scope',
    keyResolver,
  } = options

  if (!issuer.trim()) throw new Error('issuer must be a non-empty string')
  if (
    typeof audience === 'string'
      ? !audience.trim()
      : audience.length === 0 || audience.some((a) => !a.trim())
  ) {
    throw new Error('audience must be a non-empty string or non-empty array of non-blank strings')
  }

  return {
    async validate(
      input: OAuthResourceTokenValidationInput,
    ): Promise<OAuthResourceTokenValidationResult> {
      let resolverFailed = false

      // Wrap keyResolver to detect resolver-thrown errors vs jose-internal
      // errors. The wrapper discards the thrown message — it may contain
      // IdP URLs, JWKS endpoint addresses, or stack frames.
      const wrappedKey: JWTVerifyGetKey = async (protectedHeader) => {
        try {
          return await keyResolver(protectedHeader)
        } catch {
          resolverFailed = true
          throw new Error()
        }
      }

      let payload: Record<string, unknown>

      try {
        const verified = await jwtVerify(input.token, wrappedKey, {
          issuer,
          audience: typeof audience === 'string' ? audience : [...audience],
          clockTolerance: clockSkewSeconds,
          algorithms: [...allowedAlgorithms],
          requiredClaims: ['exp'],
        })
        payload = verified.payload as Record<string, unknown>
      } catch (err) {
        if (resolverFailed) {
          return { ok: false, reason: 'validator_unavailable' }
        }

        const code = (err as { code?: string }).code
        const claim = (err as { claim?: string }).claim

        if (code === 'ERR_JWT_EXPIRED') {
          return { ok: false, reason: 'expired' }
        }
        if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
          if (claim === 'iss') return { ok: false, reason: 'invalid_issuer' }
          if (claim === 'aud') return { ok: false, reason: 'invalid_audience' }
          return { ok: false, reason: 'malformed' }
        }
        if (
          code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
          code === 'ERR_JOSE_ALG_NOT_ALLOWED' ||
          code === 'ERR_JOSE_NOT_SUPPORTED'
        ) {
          return { ok: false, reason: 'invalid_signature' }
        }
        // ERR_JWS_INVALID (structural parse failure — not enough parts,
        // invalid base64url, etc.) and all other JOSE errors → malformed.
        return { ok: false, reason: 'malformed' }
      }

      if (typeof payload.sub !== 'string' || payload.sub === '') {
        return { ok: false, reason: 'malformed' }
      }

      const scopes = parseScopesClaim(payload, scopeClaim)

      const grantedSet = new Set<string>(scopes)
      for (const required of input.requiredScopes) {
        if (!grantedSet.has(required)) {
          return { ok: false, reason: 'insufficient_scope' }
        }
      }

      return {
        ok: true,
        subject: payload.sub,
        issuer,
        audience: typeof audience === 'string' ? audience : [...audience],
        scopes,
        expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      }
    },
  }
}
