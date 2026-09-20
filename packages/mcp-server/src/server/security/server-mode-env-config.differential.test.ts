/**
 * The env parser, judged against itself as it stood before the split into
 * per-field readers.
 *
 * The oracle is the OLD implementation, frozen below and copied verbatim
 * apart from its name. It must NOT be re-synced when the live parser
 * changes — a deliberate behaviour change means deleting the case from the
 * generator and saying why here.
 *
 * This file exists because the subject is SECURITY parsing: what it admits
 * decides which origins a deployment trusts and which JWKS endpoint it
 * fetches keys from. Every value in the generator below is a branch
 * discriminator, not a random string — a random string fails
 * `external_url_required` every time and would agree for the wrong reason.
 */
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { parseOriginPatternEntry } from './origin-pattern.js'
import {
  ENV_KEYS,
  parseServerModeEnvConfig,
  type ServerModeEnvConfigResult,
} from './server-mode-env-config.js'

type ServerModeAuthStrategy = 'oauth-jwt'
type Failure = Extract<ServerModeEnvConfigResult, { ok: false }>

function fail(code: Failure['code'], field: string): Failure {
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

function parseOld(env: NodeJS.ProcessEnv): ServerModeEnvConfigResult {
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

/** Every value below decides a branch; none is decoration. */
const VALUES: Record<string, readonly (string | undefined)[]> = {
  [ENV_KEYS.EXTERNAL_URL]: [undefined, '', '   ', 'http://wb.example.com'],
  [ENV_KEYS.AUTH_STRATEGY]: [undefined, '', ' oauth-jwt ', 'basic'],
  [ENV_KEYS.JWT_ISSUER]: [undefined, ''],
  [ENV_KEYS.JWT_AUDIENCE]: [undefined, '', ',', ' , ', 'wb,other'],
  [ENV_KEYS.JWKS_URI]: [
    undefined,
    '',
    'not a url',
    'http://auth.example.com/jwks.json',
    'https://u:p@auth.example.com/jwks.json',
    'https://auth.example.com/jwks.json?x=1',
    'https://auth.example.com/jwks.json#frag',
  ],
  [ENV_KEYS.ALLOWED_ORIGINS]: [
    undefined,
    '',
    '   ',
    'https://a.example.com',
    'https://a.example.com,https://b.example.com',
    '*',
    'https://a.example.com,*',
    'https://*.example.com',
    'https://a.*.example.com',
    '*.example.com',
  ],
  [ENV_KEYS.HOST]: [undefined, '', '   ', '127.0.0.1'],
  [ENV_KEYS.PORT]: [undefined, '', '0', '1', '3099', '65535', '65536', '-1', 'abc', '80.5'],
  [ENV_KEYS.TRUSTED_PROXY]: [undefined, '', '  ', 'true', 'false', ' true ', 'TRUE', 'yes'],
  [ENV_KEYS.JWT_CLOCK_SKEW_SECONDS]: [
    undefined,
    '',
    '0',
    '60',
    '-1',
    'abc',
    '99999999999999999999999',
  ],
  [ENV_KEYS.JWT_SCOPE_CLAIM]: [undefined, '', 'scope', 'scp', ' scp ', 'roles'],
  [ENV_KEYS.JWT_ALLOW_UNTYPED_ACCESS_TOKENS]: [undefined, '', 'true', 'false', 'TRUE'],
  [ENV_KEYS.DATA_DIR]: [undefined, '', '   ', '/var/lib/whiteboard'],
}

/**
 * A deployment that parses. Everything else is this with fields REPLACED.
 *
 * Drawing all thirteen independently was the first shape and it measured
 * nothing: five fields are required, so a run where all five happen to be
 * valid has probability ~0.2% — the tally below reported **zero** valid
 * configs over 1000 runs, meaning the two parsers had only ever been
 * compared on their refusals. The fix is a denser generator, not a weaker
 * assertion.
 */
const VALID_ENV: NodeJS.ProcessEnv = {
  [ENV_KEYS.EXTERNAL_URL]: 'https://wb.example.com',
  [ENV_KEYS.AUTH_STRATEGY]: 'oauth-jwt',
  [ENV_KEYS.JWT_ISSUER]: 'https://auth.example.com',
  [ENV_KEYS.JWT_AUDIENCE]: 'wb',
  [ENV_KEYS.JWKS_URI]: 'https://auth.example.com/jwks.json',
}

const KEYS = Object.keys(VALUES)

/** The valid deployment with 0–4 fields replaced by something interesting. */
const envArbitrary: fc.Arbitrary<NodeJS.ProcessEnv> = fc
  .array(
    fc
      .constantFrom(...KEYS)
      .chain((key) =>
        fc
          .constantFrom(...(VALUES[key] as readonly (string | undefined)[]))
          .map((value) => [key, value] as const),
      ),
    { minLength: 0, maxLength: 4 },
  )
  .map((overrides) => {
    const env: NodeJS.ProcessEnv = { ...VALID_ENV }
    for (const [key, value] of overrides) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    return env
  })

const seen = { ok: 0, failures: new Set<string>() }

describe('the env parser answers exactly what it answered before the split', () => {
  fcTest.prop([envArbitrary], withDefaults({ numRuns: 500 }))('over every field', (env) => {
    const result = parseServerModeEnvConfig(env)
    if (result.ok) seen.ok += 1
    else seen.failures.add(result.code)
    expect(result).toEqual(parseOld(env))
  })
})

/**
 * A tally, not a coverage percentage: it exists because the first version
 * of the generator above agreed with the oracle on 1000 runs while never
 * once producing a valid config.
 */
describe('the generator reaches what it claims to', () => {
  it('produced valid configs AND most of the failure codes', () => {
    // Measured over five fresh runs: 190-220 valid configs and all 17
    // failure codes, every run. Pinned at the full set rather than a
    // floor, because a code the generator stops reaching is a branch the
    // two parsers stop being compared on — which is the failure this
    // tally exists to make loud.
    expect(seen.ok).toBeGreaterThan(100)
    expect(seen.failures.size).toBe(17)
  })
})
