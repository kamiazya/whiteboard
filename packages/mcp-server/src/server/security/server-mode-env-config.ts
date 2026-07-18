// Server-mode deployment config parser.
//
// Reads WHITEBOARD_SERVER_* env vars and returns a typed result.
// URL-level validation (HTTPS, origin-only, no credentials) for externalUrl
// and allowedOrigins is intentionally left to planServerModeAuth downstream;
// this layer validates only field presence, numeric types, and enum values.
//
// Non-leak contract: no failure result field contains raw env var values,
// URLs, credentials, or hostnames — failure codes and field names only.
//
// allowedOrigins invariant: entries may be exact https origins OR leftmost-
// label wildcard subdomain patterns (see origin-pattern.ts). Never
// re-normalize an entry via `new URL(entry).origin` or a plain string
// compare downstream — `new URL('https://*.example.com')` parses without
// throwing (the '*' becomes a literal hostname character), so naive
// normalization silently produces a canonical form that never matches a
// real subdomain rather than failing loudly. Always route matching through
// origin-pattern.ts's parseOriginPatternEntry / matchOrigin.

import { parseOriginPatternEntry } from './origin-pattern.js'

export const ENV_KEYS = {
  EXTERNAL_URL: 'WHITEBOARD_SERVER_EXTERNAL_URL',
  AUTH_STRATEGY: 'WHITEBOARD_SERVER_AUTH_STRATEGY',
  JWT_ISSUER: 'WHITEBOARD_SERVER_JWT_ISSUER',
  JWT_AUDIENCE: 'WHITEBOARD_SERVER_JWT_AUDIENCE',
  JWKS_URI: 'WHITEBOARD_SERVER_JWKS_URI',
  ALLOWED_ORIGINS: 'WHITEBOARD_SERVER_ALLOWED_ORIGINS',
  HOST: 'WHITEBOARD_SERVER_HOST',
  PORT: 'WHITEBOARD_SERVER_PORT',
  TRUSTED_PROXY: 'WHITEBOARD_SERVER_TRUSTED_PROXY',
  JWT_CLOCK_SKEW_SECONDS: 'WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS',
  JWT_SCOPE_CLAIM: 'WHITEBOARD_SERVER_JWT_SCOPE_CLAIM',
  JWT_ALLOW_UNTYPED_ACCESS_TOKENS: 'WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS',
  DATA_DIR: 'WHITEBOARD_DATA_DIR',
} as const

export type ServerModeAuthStrategy = 'oauth-jwt'

export interface ServerModeEnvConfig {
  /** Presence-validated; HTTPS/origin-only enforcement is downstream in planServerModeAuth. */
  externalUrl: string
  /** Raw trimmed/split list from env. Wildcard rejected here; URL validation is downstream. */
  allowedOrigins: readonly string[]
  authStrategy: ServerModeAuthStrategy
  jwtIssuer: string
  jwtAudience: readonly string[]
  jwksUri: string
  /** Tolerated clock drift in seconds. Default: 60. */
  jwtClockSkewSeconds: number
  /** Which JWT claim holds scopes. Default: 'scope'. */
  jwtScopeClaim: 'scope' | 'scp'
  /**
   * Accept access tokens with no RFC 9068 `typ: at+jwt` header and no
   * `token_use: 'access'` claim. Default: false — a false default risks
   * an ID token (issued with the same audience) being accepted as an
   * access token; only opt in when the configured IdP is known to omit
   * both discriminators.
   */
  jwtAllowUntypedAccessTokens: boolean
  /** Bind host. Default: '0.0.0.0'. */
  host: string
  /** Bind port. 1–65535. Default: 3099. */
  port: number
  /** Whether to trust reverse-proxy headers. Default: false. */
  trustedProxy: boolean
  /** Override data directory. Undefined uses the default resolver. */
  dataDir: string | undefined
}

export type ServerModeEnvConfigFailureCode =
  | 'server_mode_env.external_url_required'
  | 'server_mode_env.auth_strategy_required'
  | 'server_mode_env.unknown_auth_strategy'
  | 'server_mode_env.jwt_issuer_required'
  | 'server_mode_env.jwt_audience_required'
  | 'server_mode_env.jwks_uri_required'
  | 'server_mode_env.jwks_uri_must_be_https'
  | 'server_mode_env.jwks_uri_credentials_forbidden'
  | 'server_mode_env.jwks_uri_query_forbidden'
  | 'server_mode_env.jwks_uri_fragment_forbidden'
  | 'server_mode_env.allowed_origins_wildcard_forbidden'
  | 'server_mode_env.allowed_origins_invalid_wildcard'
  | 'server_mode_env.port_out_of_range'
  | 'server_mode_env.trusted_proxy_invalid'
  | 'server_mode_env.jwt_clock_skew_invalid'
  | 'server_mode_env.jwt_scope_claim_invalid'
  | 'server_mode_env.jwt_allow_untyped_access_tokens_invalid'

export type ServerModeEnvConfigResult =
  | { readonly ok: true; readonly config: ServerModeEnvConfig }
  | { readonly ok: false; readonly code: ServerModeEnvConfigFailureCode; readonly field: string }

function fail(
  code: ServerModeEnvConfigFailureCode,
  field: string,
): Extract<ServerModeEnvConfigResult, { ok: false }> {
  return { ok: false, code, field }
}

function splitComma(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parsePort(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  if (n < 1 || n > 65535) return null
  return n
}

function parseNonNegativeInt(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  // Very long digit strings parse as Infinity; Number.isSafeInteger rejects
  // Infinity and out-of-range values in a single check.
  if (!Number.isSafeInteger(n) || n < 0) return null
  return n
}

export function parseServerModeEnvConfig(env: NodeJS.ProcessEnv): ServerModeEnvConfigResult {
  // --- Required fields ---

  const externalUrl = (env[ENV_KEYS.EXTERNAL_URL] ?? '').trim()
  if (!externalUrl) return fail('server_mode_env.external_url_required', ENV_KEYS.EXTERNAL_URL)

  const authStrategyRaw = (env[ENV_KEYS.AUTH_STRATEGY] ?? '').trim()
  if (!authStrategyRaw)
    return fail('server_mode_env.auth_strategy_required', ENV_KEYS.AUTH_STRATEGY)
  if (authStrategyRaw !== 'oauth-jwt') {
    return fail('server_mode_env.unknown_auth_strategy', ENV_KEYS.AUTH_STRATEGY)
  }
  const authStrategy: ServerModeAuthStrategy = 'oauth-jwt'

  const jwtIssuer = (env[ENV_KEYS.JWT_ISSUER] ?? '').trim()
  if (!jwtIssuer) return fail('server_mode_env.jwt_issuer_required', ENV_KEYS.JWT_ISSUER)

  const jwtAudienceRaw = (env[ENV_KEYS.JWT_AUDIENCE] ?? '').trim()
  if (!jwtAudienceRaw) return fail('server_mode_env.jwt_audience_required', ENV_KEYS.JWT_AUDIENCE)
  const jwtAudience = splitComma(jwtAudienceRaw)
  if (jwtAudience.length === 0)
    return fail('server_mode_env.jwt_audience_required', ENV_KEYS.JWT_AUDIENCE)

  const jwksUri = (env[ENV_KEYS.JWKS_URI] ?? '').trim()
  if (!jwksUri) return fail('server_mode_env.jwks_uri_required', ENV_KEYS.JWKS_URI)
  let parsedJwksUri: URL
  try {
    parsedJwksUri = new URL(jwksUri)
  } catch {
    return fail('server_mode_env.jwks_uri_must_be_https', ENV_KEYS.JWKS_URI)
  }
  if (parsedJwksUri.protocol !== 'https:') {
    return fail('server_mode_env.jwks_uri_must_be_https', ENV_KEYS.JWKS_URI)
  }
  // Credentials, query params, and fragments in the JWKS URI are rejected:
  // credentials risk leaking secrets through process env or logs; query/fragment
  // components are not part of any OIDC JWKS endpoint contract and could
  // carry sensitive tokens.
  if (parsedJwksUri.username || parsedJwksUri.password) {
    return fail('server_mode_env.jwks_uri_credentials_forbidden', ENV_KEYS.JWKS_URI)
  }
  if (parsedJwksUri.search) {
    return fail('server_mode_env.jwks_uri_query_forbidden', ENV_KEYS.JWKS_URI)
  }
  if (parsedJwksUri.hash) {
    return fail('server_mode_env.jwks_uri_fragment_forbidden', ENV_KEYS.JWKS_URI)
  }

  // --- Optional: allowedOrigins ---

  let allowedOrigins: string[]
  const allowedOriginsRaw = env[ENV_KEYS.ALLOWED_ORIGINS]
  if (allowedOriginsRaw !== undefined && allowedOriginsRaw.trim() !== '') {
    allowedOrigins = splitComma(allowedOriginsRaw)
    if (allowedOrigins.some((o) => o === '*')) {
      return fail('server_mode_env.allowed_origins_wildcard_forbidden', ENV_KEYS.ALLOWED_ORIGINS)
    }
    for (const o of allowedOrigins) {
      if (!o.includes('*')) continue
      const result = parseOriginPatternEntry(o)
      if (!result.ok || result.pattern.kind !== 'wildcard-subdomain') {
        return fail('server_mode_env.allowed_origins_invalid_wildcard', ENV_KEYS.ALLOWED_ORIGINS)
      }
    }
  } else {
    allowedOrigins = [externalUrl]
  }

  // --- Optional: port ---

  const portRaw = env[ENV_KEYS.PORT]
  let port = 3099
  if (portRaw !== undefined) {
    const parsed = parsePort(portRaw)
    if (parsed === null) return fail('server_mode_env.port_out_of_range', ENV_KEYS.PORT)
    port = parsed
  }

  // --- Optional: trustedProxy ---

  const trustedProxyRaw = env[ENV_KEYS.TRUSTED_PROXY]
  let trustedProxy = false
  if (trustedProxyRaw !== undefined && trustedProxyRaw.trim() !== '') {
    const v = trustedProxyRaw.trim()
    if (v !== 'true' && v !== 'false') {
      return fail('server_mode_env.trusted_proxy_invalid', ENV_KEYS.TRUSTED_PROXY)
    }
    trustedProxy = v === 'true'
  }

  // --- Optional: jwtClockSkewSeconds ---

  const clockSkewRaw = env[ENV_KEYS.JWT_CLOCK_SKEW_SECONDS]
  let jwtClockSkewSeconds = 60
  if (clockSkewRaw !== undefined && clockSkewRaw.trim() !== '') {
    const parsed = parseNonNegativeInt(clockSkewRaw.trim())
    if (parsed === null) {
      return fail('server_mode_env.jwt_clock_skew_invalid', ENV_KEYS.JWT_CLOCK_SKEW_SECONDS)
    }
    jwtClockSkewSeconds = parsed
  }

  // --- Optional: jwtScopeClaim ---

  const scopeClaimRaw = env[ENV_KEYS.JWT_SCOPE_CLAIM]
  let jwtScopeClaim: 'scope' | 'scp' = 'scope'
  if (scopeClaimRaw !== undefined && scopeClaimRaw.trim() !== '') {
    const v = scopeClaimRaw.trim()
    if (v !== 'scope' && v !== 'scp') {
      return fail('server_mode_env.jwt_scope_claim_invalid', ENV_KEYS.JWT_SCOPE_CLAIM)
    }
    jwtScopeClaim = v
  }

  // --- Optional: jwtAllowUntypedAccessTokens ---

  const allowUntypedRaw = env[ENV_KEYS.JWT_ALLOW_UNTYPED_ACCESS_TOKENS]
  let jwtAllowUntypedAccessTokens = false
  if (allowUntypedRaw !== undefined && allowUntypedRaw.trim() !== '') {
    const v = allowUntypedRaw.trim()
    if (v !== 'true' && v !== 'false') {
      return fail(
        'server_mode_env.jwt_allow_untyped_access_tokens_invalid',
        ENV_KEYS.JWT_ALLOW_UNTYPED_ACCESS_TOKENS,
      )
    }
    jwtAllowUntypedAccessTokens = v === 'true'
  }

  // --- Optional: host ---

  const host = (env[ENV_KEYS.HOST] ?? '0.0.0.0').trim() || '0.0.0.0'

  // --- Optional: dataDir ---

  const dataDirRaw = env[ENV_KEYS.DATA_DIR]
  const dataDir = dataDirRaw?.trim() || undefined

  return {
    ok: true,
    config: {
      externalUrl,
      allowedOrigins,
      authStrategy,
      jwtIssuer,
      jwtAudience,
      jwksUri,
      jwtClockSkewSeconds,
      jwtScopeClaim,
      jwtAllowUntypedAccessTokens,
      host,
      port,
      trustedProxy,
      dataDir,
    },
  }
}
