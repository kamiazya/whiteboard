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

type ServerModeAuthStrategy = 'oauth-jwt'

interface ServerModeEnvConfig {
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

type ServerModeEnvConfigFailureCode =
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

/**
 * An optional env var's TRIMMED value, or undefined when it is absent or
 * blank. The `x !== undefined && x.trim() !== ''` preamble stood at five
 * fields, each followed by its own trim — and "unset" and "set to spaces"
 * mean the same thing here, which is the only reason that preamble is the
 * same every time.
 */
function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const trimmed = env[key]?.trim()
  return trimmed ? trimmed : undefined
}

/** A required env var's trimmed value, or null when it is absent or blank. */
function required(env: NodeJS.ProcessEnv, key: string): string | null {
  return optional(env, key) ?? null
}

/**
 * An optional env var constrained to a fixed set, defaulted when absent.
 * Answers `null` for a value outside the set, so the caller names the
 * failure code — the codes are per-field and the messages are the contract.
 */
function optionalOneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T | null {
  const value = optional(env, key)
  if (value === undefined) return fallback
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/** Two fields are booleans, spelled exactly `true` or `false`. */
function optionalBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean | null {
  const value = optionalOneOf(env, key, ['true', 'false'] as const, fallback ? 'true' : 'false')
  return value === null ? null : value === 'true'
}

/**
 * Everything the JWKS URI has to be, in one place: an https URL carrying no
 * credentials, query or fragment. Credentials risk leaking secrets through
 * process env or logs; query and fragment components are not part of any
 * OIDC JWKS endpoint contract and could carry sensitive tokens.
 */
function checkJwksUri(uri: string): ServerModeEnvConfigFailureCode | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return 'server_mode_env.jwks_uri_must_be_https'
  }
  if (parsed.protocol !== 'https:') return 'server_mode_env.jwks_uri_must_be_https'
  if (parsed.username || parsed.password) return 'server_mode_env.jwks_uri_credentials_forbidden'
  if (parsed.search) return 'server_mode_env.jwks_uri_query_forbidden'
  if (parsed.hash) return 'server_mode_env.jwks_uri_fragment_forbidden'
  return null
}

/**
 * The allowed-origin list, or the failure code it breaks. A bare `*` is
 * refused outright; anything else carrying one has to be a leftmost-label
 * wildcard that `origin-pattern.ts` recognises, since that is the only
 * wildcard shape matching can honour later.
 */
function checkAllowedOrigins(origins: readonly string[]): ServerModeEnvConfigFailureCode | null {
  if (origins.some((o) => o === '*')) {
    return 'server_mode_env.allowed_origins_wildcard_forbidden'
  }
  for (const o of origins) {
    if (!o.includes('*')) continue
    const result = parseOriginPatternEntry(o)
    if (!result.ok || result.pattern.kind !== 'wildcard-subdomain') {
      return 'server_mode_env.allowed_origins_invalid_wildcard'
    }
  }
  return null
}

/**
 * What the JWT surface REQUIRES: absent or wrong is a refusal, not a default.
 * Split from the tuning below because the two halves fail differently — these
 * stop the daemon starting, those only narrow how it behaves.
 */
function parseRequiredAuth(
  env: NodeJS.ProcessEnv,
):
  | { ok: true; jwtIssuer: string; jwtAudience: string[]; jwksUri: string }
  | ServerModeEnvConfigResult {
  const authStrategyRaw = required(env, ENV_KEYS.AUTH_STRATEGY)
  if (authStrategyRaw === null) {
    return fail('server_mode_env.auth_strategy_required', ENV_KEYS.AUTH_STRATEGY)
  }
  if (authStrategyRaw !== 'oauth-jwt') {
    return fail('server_mode_env.unknown_auth_strategy', ENV_KEYS.AUTH_STRATEGY)
  }

  const jwtIssuer = required(env, ENV_KEYS.JWT_ISSUER)
  if (jwtIssuer === null) {
    return fail('server_mode_env.jwt_issuer_required', ENV_KEYS.JWT_ISSUER)
  }

  const jwtAudienceRaw = required(env, ENV_KEYS.JWT_AUDIENCE)
  const jwtAudience = jwtAudienceRaw === null ? [] : splitComma(jwtAudienceRaw)
  if (jwtAudience.length === 0) {
    return fail('server_mode_env.jwt_audience_required', ENV_KEYS.JWT_AUDIENCE)
  }

  const jwksUri = required(env, ENV_KEYS.JWKS_URI)
  if (jwksUri === null) return fail('server_mode_env.jwks_uri_required', ENV_KEYS.JWKS_URI)
  const jwksFailure = checkJwksUri(jwksUri)
  if (jwksFailure !== null) return fail(jwksFailure, ENV_KEYS.JWKS_URI)

  return { ok: true, jwtIssuer, jwtAudience, jwksUri }
}

/** The transport knobs: a port and whether a proxy in front is trusted. */
function parseTransportTuning(
  env: NodeJS.ProcessEnv,
): { ok: true; port: number; trustedProxy: boolean } | ServerModeEnvConfigResult {
  const portRaw = env[ENV_KEYS.PORT]
  const port = portRaw === undefined ? 3099 : parsePort(portRaw)
  if (port === null) return fail('server_mode_env.port_out_of_range', ENV_KEYS.PORT)

  const trustedProxy = optionalBoolean(env, ENV_KEYS.TRUSTED_PROXY, false)
  if (trustedProxy === null) {
    return fail('server_mode_env.trusted_proxy_invalid', ENV_KEYS.TRUSTED_PROXY)
  }
  return { ok: true, port, trustedProxy }
}

/** The JWT knobs that have a default: present-but-invalid refuses, absent does not. */
function parseJwtTuning(env: NodeJS.ProcessEnv):
  | {
      ok: true
      jwtClockSkewSeconds: number
      jwtScopeClaim: 'scope' | 'scp'
      jwtAllowUntypedAccessTokens: boolean
    }
  | ServerModeEnvConfigResult {
  const clockSkewRaw = optional(env, ENV_KEYS.JWT_CLOCK_SKEW_SECONDS)
  const jwtClockSkewSeconds = clockSkewRaw === undefined ? 60 : parseNonNegativeInt(clockSkewRaw)
  if (jwtClockSkewSeconds === null) {
    return fail('server_mode_env.jwt_clock_skew_invalid', ENV_KEYS.JWT_CLOCK_SKEW_SECONDS)
  }

  const jwtScopeClaim = optionalOneOf(env, ENV_KEYS.JWT_SCOPE_CLAIM, ['scope', 'scp'], 'scope')
  if (jwtScopeClaim === null) {
    return fail('server_mode_env.jwt_scope_claim_invalid', ENV_KEYS.JWT_SCOPE_CLAIM)
  }

  const jwtAllowUntypedAccessTokens = optionalBoolean(
    env,
    ENV_KEYS.JWT_ALLOW_UNTYPED_ACCESS_TOKENS,
    false,
  )
  if (jwtAllowUntypedAccessTokens === null) {
    return fail(
      'server_mode_env.jwt_allow_untyped_access_tokens_invalid',
      ENV_KEYS.JWT_ALLOW_UNTYPED_ACCESS_TOKENS,
    )
  }
  return { ok: true, jwtClockSkewSeconds, jwtScopeClaim, jwtAllowUntypedAccessTokens }
}

export function parseServerModeEnvConfig(env: NodeJS.ProcessEnv): ServerModeEnvConfigResult {
  const externalUrl = required(env, ENV_KEYS.EXTERNAL_URL)
  if (externalUrl === null) {
    return fail('server_mode_env.external_url_required', ENV_KEYS.EXTERNAL_URL)
  }

  const auth = parseRequiredAuth(env)
  if (!('jwtIssuer' in auth)) return auth

  const allowedOriginsRaw = optional(env, ENV_KEYS.ALLOWED_ORIGINS)
  const allowedOrigins =
    allowedOriginsRaw === undefined ? [externalUrl] : splitComma(allowedOriginsRaw)
  if (allowedOriginsRaw !== undefined) {
    const originsFailure = checkAllowedOrigins(allowedOrigins)
    if (originsFailure !== null) return fail(originsFailure, ENV_KEYS.ALLOWED_ORIGINS)
  }

  const transport = parseTransportTuning(env)
  if (!('port' in transport)) return transport

  const jwt = parseJwtTuning(env)
  if (!('jwtScopeClaim' in jwt)) return jwt

  return {
    ok: true,
    config: {
      externalUrl,
      allowedOrigins,
      authStrategy: 'oauth-jwt',
      jwtIssuer: auth.jwtIssuer,
      jwtAudience: auth.jwtAudience,
      jwksUri: auth.jwksUri,
      jwtClockSkewSeconds: jwt.jwtClockSkewSeconds,
      jwtScopeClaim: jwt.jwtScopeClaim,
      jwtAllowUntypedAccessTokens: jwt.jwtAllowUntypedAccessTokens,
      host: optional(env, ENV_KEYS.HOST) ?? '0.0.0.0',
      port: transport.port,
      trustedProxy: transport.trustedProxy,
      dataDir: optional(env, ENV_KEYS.DATA_DIR),
    },
  }
}
