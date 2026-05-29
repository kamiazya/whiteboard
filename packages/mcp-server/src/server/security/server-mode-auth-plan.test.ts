import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { planServerModeAuth } from './server-mode-auth-plan.js'

// AuthScope vocabulary for structural assertion (mirrors auth-strategy.ts union)
const AUTH_SCOPE_VOCABULARY = new Set([
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

// ── Local-daemon ─────────────────────────────────────────────────────────────

describe('planServerModeAuth — local-daemon', () => {
  it('loopback bindHost → ok local-loopback, routeAuthPlan null, trustedProxy false', () => {
    const result = planServerModeAuth({ mode: 'local-daemon', bindHost: '127.0.0.1' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('local-loopback')
    expect(result.routeAuthPlan).toBeNull()
    expect(result.trustedProxy).toBe(false)
    expect(result.pnaHeader).toBe('loopback')
  })

  it('non-loopback bindHost → reject regardless of other inputs', () => {
    const result = planServerModeAuth({
      mode: 'local-daemon',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: ['https://app.example.com'],
      trustedProxy: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('local_daemon.non_loopback_forbidden')
  })

  it('local-daemon allowedOrigins contains all three loopback http origins', () => {
    const result = planServerModeAuth({ mode: 'local-daemon', bindHost: 'localhost' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.allowedOrigins).toContain('http://127.0.0.1')
    expect(result.allowedOrigins).toContain('http://localhost')
    expect(result.allowedOrigins).toContain('http://[::1]')
  })

  it('local-daemon publicBaseUrl reflects the loopback bindHost', () => {
    const result = planServerModeAuth({ mode: 'local-daemon', bindHost: '127.0.0.1' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.publicBaseUrl).toBe('http://127.0.0.1')
  })

  it('local-daemon IPv6 loopback → publicBaseUrl uses bracketed form', () => {
    const result = planServerModeAuth({ mode: 'local-daemon', bindHost: '::1' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.publicBaseUrl).toBe('http://[::1]')
  })
})

// ── Server-mode config validation ────────────────────────────────────────────

describe('planServerModeAuth — server-mode config validation', () => {
  it('missing externalUrl → reject', () => {
    const result = planServerModeAuth({ mode: 'server-mode', bindHost: '0.0.0.0' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('server_mode.external_url_required')
  })

  it('http externalUrl → reject', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'http://app.example.com',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('server_mode.external_url_must_be_https')
  })

  it('https origin-only externalUrl → ok server-mode', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.kind).toBe('server-mode')
  })

  it('wildcard allowedOrigin → reject', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: ['*'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('server_mode.wildcard_origin_forbidden')
  })

  it('allowedOrigin with path → reject', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: ['https://app.example.com/path'],
    })

    expect(result.ok).toBe(false)
  })

  it('allowedOrigin with query string → reject', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: ['https://app.example.com?q=1'],
    })

    expect(result.ok).toBe(false)
  })

  it('allowedOrigin with credentials → reject', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: ['https://user:pass@app.example.com'],
    })

    expect(result.ok).toBe(false)
  })

  it('allowedOrigin with fragment → reject', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: ['https://app.example.com#section'],
    })

    expect(result.ok).toBe(false)
  })
})

// ── Server-mode plan content ─────────────────────────────────────────────────

describe('planServerModeAuth — server-mode plan content', () => {
  function makeServerPlan(
    overrides: Partial<Parameters<typeof planServerModeAuth>[0]> = {},
  ) {
    return planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: ['https://app.example.com'],
      ...overrides,
    })
  }

  it('accepted allowedOrigins are URL.origin-normalized — default port stripped', () => {
    const result = makeServerPlan({
      allowedOrigins: ['https://app.example.com:443'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // :443 is the default https port — URL.origin strips it
    expect(result.allowedOrigins).toContain('https://app.example.com')
    for (const origin of result.allowedOrigins) {
      expect(origin).toBe(new URL(origin).origin)
    }
  })

  it('non-default port is preserved in normalized allowedOrigin', () => {
    const result = makeServerPlan({
      allowedOrigins: ['https://app.example.com:8443'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.allowedOrigins).toContain('https://app.example.com:8443')
    for (const origin of result.allowedOrigins) {
      expect(origin).toBe(new URL(origin).origin)
    }
  })

  it('routeAuthPlan uses only AuthScope vocabulary', () => {
    const result = makeServerPlan()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.routeAuthPlan).not.toBeNull()
    for (const entry of result.routeAuthPlan!) {
      for (const scope of entry.requiredScopes) {
        expect(AUTH_SCOPE_VOCABULARY.has(scope)).toBe(true)
      }
    }
  })

  it('routeAuthPlan matches the exact resource-level scope contract', () => {
    const result = makeServerPlan()

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const expected = {
      'canvas-read':     ['canvas:read'],
      'workspace-read':  ['workspace:read'],
      'versions-read':   ['versions:read'],
      'files-read':      ['files:read'],
      'canvas-write':    ['canvas:write'],
      'workspace-write': ['workspace:write'],
      'versions-write':  ['versions:write'],
      'files-write':     ['files:write'],
      'runtime-read':    ['runtime:read'],
      'runtime-admin':   ['runtime:admin'],
      'mcp':             ['mcp:call'],
    }

    // Length check catches duplicate group entries that Object.fromEntries would silently collapse
    expect(result.routeAuthPlan).toHaveLength(Object.keys(expected).length)

    const grouped = Object.fromEntries(
      result.routeAuthPlan!.map((e) => [e.group, [...e.requiredScopes]]),
    )
    expect(grouped).toEqual(expected)
  })

  it('mutating a returned routeAuthPlan does not affect a subsequent plan result', () => {
    const result1 = makeServerPlan()
    expect(result1.ok).toBe(true)
    if (!result1.ok) return

    // Cast away readonly and mutate both the array and a nested requiredScopes
    const plan = result1.routeAuthPlan as Array<{ group: string; requiredScopes: string[] }>
    plan.push({ group: 'injected', requiredScopes: ['mcp:call'] })
    plan[0].requiredScopes.push('runtime:admin')

    // A fresh call must return the original unmodified plan
    const result2 = makeServerPlan()
    expect(result2.ok).toBe(true)
    if (!result2.ok) return

    expect(result2.routeAuthPlan!.find((e) => e.group === 'injected')).toBeUndefined()
    const canvasRead = result2.routeAuthPlan!.find((e) => e.group === 'canvas-read')
    expect(canvasRead!.requiredScopes).toEqual(['canvas:read'])
  })

  it('runtime-admin is a separate group from runtime-read — read scope cannot authorize admin ops', () => {
    const result = makeServerPlan()

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const adminEntry = result.routeAuthPlan!.find((e) => e.group === 'runtime-admin')
    expect(adminEntry).toBeDefined()
    expect(adminEntry!.requiredScopes).not.toContain('runtime:read')
    expect(adminEntry!.requiredScopes).toContain('runtime:admin')

    const readEntry = result.routeAuthPlan!.find((e) => e.group === 'runtime-read')
    expect(readEntry).toBeDefined()
    expect(readEntry!.requiredScopes).not.toContain('runtime:admin')
  })

  it('pnaHeader is disabled for server-mode', () => {
    const result = makeServerPlan()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.pnaHeader).toBe('disabled')
  })

  it('publicBaseUrl is derived from externalUrl origin', () => {
    const result = makeServerPlan({ externalUrl: 'https://myapp.example.com' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.publicBaseUrl).toBe('https://myapp.example.com')
  })

  it('trustedProxy defaults to false', () => {
    const result = makeServerPlan({ trustedProxy: undefined })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.trustedProxy).toBe(false)
  })

  it('trustedProxy true is preserved in plan', () => {
    const result = makeServerPlan({ trustedProxy: true })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.trustedProxy).toBe(true)
  })

  it('server-mode plan output has no dataDir, bindHost, or internal token fields', () => {
    const result = makeServerPlan()

    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('dataDir')
    expect(serialized).not.toContain('bindHost')
    // Verify only expected top-level fields are present
    if (result.ok) {
      expect(Object.keys(result).sort()).toEqual(
        ['allowedOrigins', 'kind', 'ok', 'pnaHeader', 'publicBaseUrl', 'routeAuthPlan', 'trustedProxy'],
      )
    }
  })
})

// ── Non-leak ─────────────────────────────────────────────────────────────────

describe('planServerModeAuth — non-leak', () => {
  it('failure decision does not contain raw externalUrl query string', () => {
    const SECRET = 'secret-token-XYZABC123'
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: `https://app.example.com?token=${SECRET}`,
    })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SECRET)
  })

  it('failure decision does not contain credentials from allowedOrigin', () => {
    const SECRET = 'bearer-credential-XYZABC'
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: [`https://user:${SECRET}@app.example.com`],
    })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SECRET)
  })

  it('failure decision does not contain /Users/ path prefix from input', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com/Users/config',
    })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('/Users/')
  })

  it('failure decision does not contain raw Authorization / Bearer value from input', () => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com?Authorization=Bearer-token-XYZABC',
    })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('Bearer-token-XYZABC')
  })

  it('failure decision does not contain raw externalUrl fragment', () => {
    const CANARY = 'fragment-secret-XYZABC'
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: `https://app.example.com#${CANARY}`,
    })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(CANARY)
  })
})

// ── PBT ─────────────────────────────────────────────────────────────────────

fcTest.prop(
  [
    fc.array(
      fc.oneof(
        fc.constant(443),
        fc.integer({ min: 1024, max: 65535 }),
      ).map((port) => `https://host-example.com:${port}`),
      { minLength: 1, maxLength: 4 },
    ),
  ],
  withDefaults(),
)(
  'every accepted allowedOrigin in server-mode plan equals its own URL.origin',
  (origins) => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://app.example.com',
      allowedOrigins: origins,
    })

    if (!result.ok) return
    for (const origin of result.allowedOrigins) {
      expect(origin).toBe(new URL(origin).origin)
      expect(origin.startsWith('https://')).toBe(true)
    }
  },
)

fcTest.prop(
  [fc.integer({ min: 10000000, max: 99999999 }).map((n) => `CANARY${n}`)],
  withDefaults(),
)(
  'canary embedded in rejected externalUrl query does not appear in failure decision',
  (canary) => {
    const result = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: `https://app.example.com?secret=${canary}`,
    })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(canary)
  },
)
