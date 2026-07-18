import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { ENV_KEYS, parseServerModeEnvConfig } from './server-mode-env-config.js'

// Minimal valid env that satisfies all required fields.
const VALID_ENV: NodeJS.ProcessEnv = {
  WHITEBOARD_SERVER_EXTERNAL_URL: 'https://whiteboard.example.com',
  WHITEBOARD_SERVER_AUTH_STRATEGY: 'oauth-jwt',
  WHITEBOARD_SERVER_JWT_ISSUER: 'https://auth.example.com',
  WHITEBOARD_SERVER_JWT_AUDIENCE: 'https://whiteboard.example.com',
  WHITEBOARD_SERVER_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parseServerModeEnvConfig — valid config', () => {
  it('parses minimal required env and returns ok result', () => {
    const result = parseServerModeEnvConfig(VALID_ENV)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.externalUrl).toBe('https://whiteboard.example.com')
    expect(result.config.authStrategy).toBe('oauth-jwt')
    expect(result.config.jwtIssuer).toBe('https://auth.example.com')
    expect(result.config.jwtAudience).toEqual(['https://whiteboard.example.com'])
    expect(result.config.jwksUri).toBe('https://auth.example.com/.well-known/jwks.json')
  })

  it('defaults: host=0.0.0.0, port=3099, trustedProxy=false, clockSkew=60, scopeClaim=scope', () => {
    const result = parseServerModeEnvConfig(VALID_ENV)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.host).toBe('0.0.0.0')
    expect(result.config.port).toBe(3099)
    expect(result.config.trustedProxy).toBe(false)
    expect(result.config.jwtClockSkewSeconds).toBe(60)
    expect(result.config.jwtScopeClaim).toBe('scope')
    expect(result.config.dataDir).toBeUndefined()
  })

  it('defaults jwtAllowUntypedAccessTokens to false (safe default — RFC 9068 typ discrimination required)', () => {
    const result = parseServerModeEnvConfig(VALID_ENV)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtAllowUntypedAccessTokens).toBe(false)
  })

  it('parses WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS=true', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS: 'true',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtAllowUntypedAccessTokens).toBe(true)
  })

  it('invalid WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS value → jwt_allow_untyped_access_tokens_invalid', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS: 'yes',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_allow_untyped_access_tokens_invalid')
    expect(result.field).toBe('WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS')
  })

  it('defaults allowedOrigins to [externalUrl origin] when not set', () => {
    const result = parseServerModeEnvConfig(VALID_ENV)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.allowedOrigins).toEqual(['https://whiteboard.example.com'])
  })

  it('parses comma-separated allowedOrigins', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.allowedOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ])
  })

  it('double comma in allowedOrigins produces no empty entries', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: 'https://a.example.com,,https://b.example.com',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.allowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('parses comma-separated jwtAudience', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_AUDIENCE: 'aud-1, aud-2',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtAudience).toEqual(['aud-1', 'aud-2'])
  })

  it('parses port from env', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_PORT: '8080',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.port).toBe(8080)
  })

  it('parses trustedProxy=true', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_TRUSTED_PROXY: 'true',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.trustedProxy).toBe(true)
  })

  it('trustedProxy with surrounding whitespace is trimmed and accepted', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_TRUSTED_PROXY: '  true  ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.trustedProxy).toBe(true)
  })

  it('parses jwtScopeClaim=scp', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_SCOPE_CLAIM: 'scp',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtScopeClaim).toBe('scp')
  })

  it('jwtScopeClaim with surrounding whitespace is trimmed and accepted', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_SCOPE_CLAIM: '  scp  ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtScopeClaim).toBe('scp')
  })

  it('whitespace-only PORT fails with port_out_of_range (fail-closed: set but empty is invalid)', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })

  it('whitespace-only JWT_CLOCK_SKEW_SECONDS uses default 60', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '   ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtClockSkewSeconds).toBe(60)
  })

  it('parses custom jwtClockSkewSeconds', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '30',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtClockSkewSeconds).toBe(30)
  })

  it('accepts 0 for jwtClockSkewSeconds', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '0',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtClockSkewSeconds).toBe(0)
  })

  it('passes dataDir through when set', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_DATA_DIR: '/var/lib/whiteboard',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.dataDir).toBe('/var/lib/whiteboard')
  })

  it('whitespace-only WHITEBOARD_DATA_DIR falls back to undefined', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_DATA_DIR: '   ' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.dataDir).toBeUndefined()
  })

  it('whitespace-only HOST falls back to 0.0.0.0', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_HOST: '   ' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.host).toBe('0.0.0.0')
  })

  it('JWKS URI with surrounding whitespace is accepted and trimmed', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: '  https://auth.example.com/.well-known/jwks.json  ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwksUri).toBe('https://auth.example.com/.well-known/jwks.json')
  })

  it('accepts port boundary: 1', () => {
    expect(parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '1' }).ok).toBe(true)
  })

  it('accepts port boundary: 65535', () => {
    expect(parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '65535' }).ok).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// Required field missing
// ---------------------------------------------------------------------------

describe('parseServerModeEnvConfig — required field missing', () => {
  it.each([
    [ENV_KEYS.EXTERNAL_URL, 'server_mode_env.external_url_required', ENV_KEYS.EXTERNAL_URL],
    [ENV_KEYS.AUTH_STRATEGY, 'server_mode_env.auth_strategy_required', ENV_KEYS.AUTH_STRATEGY],
    [ENV_KEYS.JWT_ISSUER, 'server_mode_env.jwt_issuer_required', ENV_KEYS.JWT_ISSUER],
    [ENV_KEYS.JWT_AUDIENCE, 'server_mode_env.jwt_audience_required', ENV_KEYS.JWT_AUDIENCE],
    [ENV_KEYS.JWKS_URI, 'server_mode_env.jwks_uri_required', ENV_KEYS.JWKS_URI],
  ])('missing %s → code %s, field %s', (key, expectedCode, expectedField) => {
    const env = { ...VALID_ENV }
    delete env[key]
    const result = parseServerModeEnvConfig(env)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(expectedCode)
    expect(result.field).toBe(expectedField)
  })

  it('empty-string EXTERNAL_URL is treated as missing', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_EXTERNAL_URL: '' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.external_url_required')
    expect(result.field).toBe(ENV_KEYS.EXTERNAL_URL)
  })

  it('whitespace-only JWT_ISSUER is treated as missing', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_JWT_ISSUER: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_issuer_required')
    expect(result.field).toBe(ENV_KEYS.JWT_ISSUER)
  })

  it('whitespace-only JWT_AUDIENCE is treated as missing', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_JWT_AUDIENCE: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_audience_required')
    expect(result.field).toBe(ENV_KEYS.JWT_AUDIENCE)
  })

  it('comma-only JWT_AUDIENCE (empty entries after split) → jwt_audience_required', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_JWT_AUDIENCE: ',,' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_audience_required')
    expect(result.field).toBe(ENV_KEYS.JWT_AUDIENCE)
  })
})

// ---------------------------------------------------------------------------
// Enum / type validation
// ---------------------------------------------------------------------------

describe('parseServerModeEnvConfig — type / enum validation', () => {
  it('unknown auth strategy → unknown_auth_strategy', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_AUTH_STRATEGY: 'local-token',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.unknown_auth_strategy')
  })

  it('port 0 → port_out_of_range', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '0' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })

  it('port 65536 → port_out_of_range', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '65536' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })

  it('non-integer port → port_out_of_range', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: 'abc' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })

  it('scientific notation port "1e3" → port_out_of_range', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '1e3' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })

  it('hex notation port "0x50" → port_out_of_range', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '0x50' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })

  it('scientific notation clockSkew "1e3" → jwt_clock_skew_invalid', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '1e3',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_clock_skew_invalid')
  })

  it('hex notation clockSkew "0x3C" → jwt_clock_skew_invalid', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '0x3C',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_clock_skew_invalid')
  })

  it('digit-overflow clockSkew (parses as Infinity) → jwt_clock_skew_invalid', () => {
    // Number('9'.repeat(400)) === Infinity; Number.isSafeInteger(Infinity) is false
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '9'.repeat(400),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_clock_skew_invalid')
  })

  it('JWKS URI with credentials → jwks_uri_credentials_forbidden', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: 'https://user:pass@auth.example.com/.well-known/jwks.json',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwks_uri_credentials_forbidden')
  })

  it('JWKS URI with query → jwks_uri_query_forbidden', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json?token=secret',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwks_uri_query_forbidden')
  })

  it('JWKS URI with fragment → jwks_uri_fragment_forbidden', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json#section',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwks_uri_fragment_forbidden')
  })

  it('trustedProxy="yes" → trusted_proxy_invalid', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_TRUSTED_PROXY: 'yes',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.trusted_proxy_invalid')
  })

  it('negative clockSkew → jwt_clock_skew_invalid', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_clock_skew_invalid')
  })

  it('non-integer clockSkew → jwt_clock_skew_invalid', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '1.5',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_clock_skew_invalid')
  })

  it('unknown scopeClaim → jwt_scope_claim_invalid', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_SCOPE_CLAIM: 'claims',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwt_scope_claim_invalid')
  })

  it('JWKS URI with http (non-HTTPS) → jwks_uri_must_be_https', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: 'http://auth.example.com/.well-known/jwks.json',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwks_uri_must_be_https')
  })

  it('wildcard in allowedOrigins → allowed_origins_wildcard_forbidden', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: '*',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.allowed_origins_wildcard_forbidden')
  })

  it('wildcard mixed in allowedOrigins → allowed_origins_wildcard_forbidden', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: 'https://example.com, *',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.allowed_origins_wildcard_forbidden')
  })

  it('accepts a valid wildcard subdomain pattern in allowedOrigins', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: 'https://*.kamiazya-whiteboard.pages.dev',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.allowedOrigins).toEqual(['https://*.kamiazya-whiteboard.pages.dev'])
  })

  it('rejects a structurally invalid wildcard pattern → allowed_origins_invalid_wildcard', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: 'https://foo*.example.com',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.allowed_origins_invalid_wildcard')
    expect(result.field).toBe(ENV_KEYS.ALLOWED_ORIGINS)
  })

  it('rejects a too-short wildcard suffix → allowed_origins_invalid_wildcard', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: 'https://*.dev',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.allowed_origins_invalid_wildcard')
  })
})

// ---------------------------------------------------------------------------
// Failure field contract: operator uses result.field to identify the bad var
// ---------------------------------------------------------------------------

describe('parseServerModeEnvConfig — failure field contract', () => {
  it.each([
    [
      { WHITEBOARD_SERVER_AUTH_STRATEGY: 'bad' },
      'server_mode_env.unknown_auth_strategy',
      ENV_KEYS.AUTH_STRATEGY,
    ],
    [
      { WHITEBOARD_SERVER_JWKS_URI: 'http://example.com/jwks' },
      'server_mode_env.jwks_uri_must_be_https',
      ENV_KEYS.JWKS_URI,
    ],
    [
      { WHITEBOARD_SERVER_JWKS_URI: 'https://user:pass@auth.example.com/jwks' },
      'server_mode_env.jwks_uri_credentials_forbidden',
      ENV_KEYS.JWKS_URI,
    ],
    [
      { WHITEBOARD_SERVER_JWKS_URI: 'https://auth.example.com/jwks?token=x' },
      'server_mode_env.jwks_uri_query_forbidden',
      ENV_KEYS.JWKS_URI,
    ],
    [
      { WHITEBOARD_SERVER_JWKS_URI: 'https://auth.example.com/jwks#frag' },
      'server_mode_env.jwks_uri_fragment_forbidden',
      ENV_KEYS.JWKS_URI,
    ],
    [
      { WHITEBOARD_SERVER_ALLOWED_ORIGINS: '*' },
      'server_mode_env.allowed_origins_wildcard_forbidden',
      ENV_KEYS.ALLOWED_ORIGINS,
    ],
    [{ WHITEBOARD_SERVER_PORT: '99999' }, 'server_mode_env.port_out_of_range', ENV_KEYS.PORT],
    [
      { WHITEBOARD_SERVER_TRUSTED_PROXY: 'yes' },
      'server_mode_env.trusted_proxy_invalid',
      ENV_KEYS.TRUSTED_PROXY,
    ],
    [
      { WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: '-5' },
      'server_mode_env.jwt_clock_skew_invalid',
      ENV_KEYS.JWT_CLOCK_SKEW_SECONDS,
    ],
    [
      { WHITEBOARD_SERVER_JWT_SCOPE_CLAIM: 'invalid' },
      'server_mode_env.jwt_scope_claim_invalid',
      ENV_KEYS.JWT_SCOPE_CLAIM,
    ],
  ] as const)('validation failure %# sets correct field', (overrides, expectedCode, expectedField) => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, ...overrides })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(expectedCode)
    expect(result.field).toBe(expectedField)
  })
})

// ---------------------------------------------------------------------------
// Non-leak: error result must not echo raw input values
// ---------------------------------------------------------------------------

describe('parseServerModeEnvConfig — non-leak', () => {
  it('JWKS URI with credentials does not appear in failure result', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: 'https://user:secret-pass@auth.example.com/jwks',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwks_uri_credentials_forbidden')
    const asText = JSON.stringify(result)
    expect(asText).not.toContain('secret-pass')
    expect(asText).not.toContain('auth.example.com')
  })

  it('external URL with credentials does not appear in failure code on missing auth_strategy', () => {
    const result = parseServerModeEnvConfig({
      WHITEBOARD_SERVER_EXTERNAL_URL: 'https://user:secret@example.com',
      // AUTH_STRATEGY intentionally missing to trigger a different error
    })
    expect(result.ok).toBe(false)
    const asText = JSON.stringify(result)
    expect(asText).not.toContain('secret')
    expect(asText).not.toContain('user')
  })
})

// ---------------------------------------------------------------------------
// ENV_KEYS constants — contract anchor (kills ObjectLiteral survivors)
// ---------------------------------------------------------------------------

describe('ENV_KEYS contract', () => {
  it('exposes all expected env var names', () => {
    expect(ENV_KEYS.EXTERNAL_URL).toBe('WHITEBOARD_SERVER_EXTERNAL_URL')
    expect(ENV_KEYS.AUTH_STRATEGY).toBe('WHITEBOARD_SERVER_AUTH_STRATEGY')
    expect(ENV_KEYS.JWT_ISSUER).toBe('WHITEBOARD_SERVER_JWT_ISSUER')
    expect(ENV_KEYS.JWT_AUDIENCE).toBe('WHITEBOARD_SERVER_JWT_AUDIENCE')
    expect(ENV_KEYS.JWKS_URI).toBe('WHITEBOARD_SERVER_JWKS_URI')
    expect(ENV_KEYS.ALLOWED_ORIGINS).toBe('WHITEBOARD_SERVER_ALLOWED_ORIGINS')
    expect(ENV_KEYS.HOST).toBe('WHITEBOARD_SERVER_HOST')
    expect(ENV_KEYS.PORT).toBe('WHITEBOARD_SERVER_PORT')
    expect(ENV_KEYS.TRUSTED_PROXY).toBe('WHITEBOARD_SERVER_TRUSTED_PROXY')
    expect(ENV_KEYS.JWT_CLOCK_SKEW_SECONDS).toBe('WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS')
    expect(ENV_KEYS.JWT_SCOPE_CLAIM).toBe('WHITEBOARD_SERVER_JWT_SCOPE_CLAIM')
    expect(ENV_KEYS.DATA_DIR).toBe('WHITEBOARD_DATA_DIR')
  })
})

// ---------------------------------------------------------------------------
// PBT: comma-separated origins parsing
// ---------------------------------------------------------------------------

describe('parseServerModeEnvConfig — PBT', () => {
  fcTest.prop(
    {
      origins: fc.array(
        fc.constantFrom(
          'https://a.example.com',
          'https://b.example.com',
          'https://c.example.com:8443',
        ),
        { minLength: 1, maxLength: 4 },
      ),
    },
    withDefaults(),
  )('non-wildcard HTTPS origins always parse successfully', ({ origins }) => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: origins.join(', '),
    })
    if (!result.ok) {
      throw new Error(`unexpected failure: ${result.code} for origins: ${origins.join(', ')}`)
    }
    expect(result.config.allowedOrigins).toEqual(origins)
  })

  fcTest.prop({ port: fc.integer({ min: 1, max: 65535 }) }, withDefaults())(
    'valid port integer always parses successfully',
    ({ port }) => {
      const result = parseServerModeEnvConfig({
        ...VALID_ENV,
        WHITEBOARD_SERVER_PORT: String(port),
      })
      if (!result.ok) {
        throw new Error(`unexpected failure for port ${port}: ${result.code}`)
      }
      expect(result.config.port).toBe(port)
    },
  )

  fcTest.prop({ skew: fc.integer({ min: 0, max: 3600 }) }, withDefaults())(
    'valid clockSkew integer (0..3600) always parses successfully',
    ({ skew }) => {
      const result = parseServerModeEnvConfig({
        ...VALID_ENV,
        WHITEBOARD_SERVER_JWT_CLOCK_SKEW_SECONDS: String(skew),
      })
      if (!result.ok) {
        throw new Error(`unexpected failure for clockSkew ${skew}: ${result.code}`)
      }
      expect(result.config.jwtClockSkewSeconds).toBe(skew)
    },
  )

  fcTest.prop(
    {
      // Generate invalid port values: out of range or non-integer strings
      badPort: fc.oneof(
        fc.integer({ min: -1000, max: 0 }).map(String),
        fc.integer({ min: 65536, max: 100000 }).map(String),
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !/^\d+$/.test(s.trim())),
      ),
    },
    withDefaults(),
  )('invalid port always fails with port_out_of_range', ({ badPort }) => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_PORT: badPort,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })
})

// ---------------------------------------------------------------------------
// Deterministic contract anchors (kills whitespace-handling and enum survivors)
// ---------------------------------------------------------------------------

describe('parseServerModeEnvConfig — deterministic contract anchors', () => {
  it('whitespace-only PORT fails with port_out_of_range (set but empty = invalid, not unset)', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_PORT: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.port_out_of_range')
  })

  it('whitespace-only EXTERNAL_URL is treated as missing', () => {
    const result = parseServerModeEnvConfig({ ...VALID_ENV, WHITEBOARD_SERVER_EXTERNAL_URL: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.external_url_required')
  })

  it('whitespace-only AUTH_STRATEGY is treated as missing', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_AUTH_STRATEGY: '   ',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.auth_strategy_required')
  })

  it('malformed JWKS URI is rejected as jwks_uri_must_be_https', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWKS_URI: 'not-a-url',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('server_mode_env.jwks_uri_must_be_https')
  })

  it('empty-string ALLOWED_ORIGINS defaults to [externalUrl]', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: '',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.allowedOrigins).toEqual(['https://whiteboard.example.com'])
  })

  it('whitespace-only ALLOWED_ORIGINS defaults to [externalUrl]', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_ALLOWED_ORIGINS: '   ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.allowedOrigins).toEqual(['https://whiteboard.example.com'])
  })

  it('parses trustedProxy=false explicitly as false', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_TRUSTED_PROXY: 'false',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.trustedProxy).toBe(false)
  })

  it('whitespace-only TRUSTED_PROXY defaults to false', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_TRUSTED_PROXY: '   ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.trustedProxy).toBe(false)
  })

  it('explicitly setting JWT_SCOPE_CLAIM=scope is accepted', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_SCOPE_CLAIM: 'scope',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtScopeClaim).toBe('scope')
  })

  it('whitespace-only JWT_SCOPE_CLAIM defaults to scope', () => {
    const result = parseServerModeEnvConfig({
      ...VALID_ENV,
      WHITEBOARD_SERVER_JWT_SCOPE_CLAIM: '   ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.jwtScopeClaim).toBe('scope')
  })
})
