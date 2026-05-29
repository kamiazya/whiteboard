import { describe, expect, it } from 'vitest'
import { parseServerRunArgs } from './server-run-args.js'

const MINIMAL_VALID = [
  '--json',
  '--dry-run',
  '--external-url=https://whiteboard.example.com',
  '--auth-strategy=oauth-jwt',
  '--jwt-issuer=https://auth.example.com',
  '--jwt-audience=api',
  '--jwks-uri=https://auth.example.com/.well-known/jwks.json',
]

describe('parseServerRunArgs — happy path', () => {
  it('parses minimal valid args', () => {
    const result = parseServerRunArgs(MINIMAL_VALID)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.json).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.externalUrl).toBe('https://whiteboard.example.com')
    expect(result.authStrategy).toBe('oauth-jwt')
    expect(result.jwtIssuer).toBe('https://auth.example.com')
    expect(result.jwtAudience).toBe('api')
    expect(result.jwksUri).toBe('https://auth.example.com/.well-known/jwks.json')
  })

  it('defaults: dryRun=false, trustedProxy=undefined, all overrides undefined', () => {
    const result = parseServerRunArgs(['--json'])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.dryRun).toBe(false)
    expect(result.trustedProxy).toBeUndefined()
    expect(result.externalUrl).toBeUndefined()
    expect(result.allowedOrigins).toBeUndefined()
    expect(result.authStrategy).toBeUndefined()
    expect(result.jwtIssuer).toBeUndefined()
    expect(result.jwtAudience).toBeUndefined()
    expect(result.jwksUri).toBeUndefined()
    expect(result.jwtClockSkew).toBeUndefined()
    expect(result.jwtScopeClaim).toBeUndefined()
    expect(result.host).toBeUndefined()
    expect(result.port).toBeUndefined()
    expect(result.dataDir).toBeUndefined()
  })

  it('parses --trusted-proxy as boolean true', () => {
    const result = parseServerRunArgs(['--json', '--trusted-proxy'])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.trustedProxy).toBe(true)
  })

  it('parses all optional flags', () => {
    const result = parseServerRunArgs([
      '--json',
      '--dry-run',
      '--external-url=https://example.com',
      '--allowed-origins=https://example.com,https://app.example.com',
      '--auth-strategy=oauth-jwt',
      '--jwt-issuer=https://auth.example.com',
      '--jwt-audience=api',
      '--jwks-uri=https://auth.example.com/jwks',
      '--jwt-clock-skew=120',
      '--jwt-scope-claim=scp',
      '--host=0.0.0.0',
      '--port=8080',
      '--data-dir=/var/lib/whiteboard',
      '--trusted-proxy',
    ])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.allowedOrigins).toBe('https://example.com,https://app.example.com')
    expect(result.jwtClockSkew).toBe('120')
    expect(result.jwtScopeClaim).toBe('scp')
    expect(result.host).toBe('0.0.0.0')
    expect(result.port).toBe('8080')
    expect(result.dataDir).toBe('/var/lib/whiteboard')
    expect(result.trustedProxy).toBe(true)
  })
})

describe('parseServerRunArgs — usage errors', () => {
  it('missing --json → usage-error', () => {
    const result = parseServerRunArgs(['--dry-run', '--external-url=https://example.com'])
    expect(result.kind).toBe('usage-error')
    if (result.kind !== 'usage-error') return
    expect(result.message).toContain('--json')
  })

  it('duplicate --json → usage-error', () => {
    const result = parseServerRunArgs(['--json', '--json'])
    expect(result.kind).toBe('usage-error')
  })

  it('duplicate --dry-run → usage-error', () => {
    const result = parseServerRunArgs(['--json', '--dry-run', '--dry-run'])
    expect(result.kind).toBe('usage-error')
  })

  it('duplicate --trusted-proxy → usage-error', () => {
    const result = parseServerRunArgs(['--json', '--trusted-proxy', '--trusted-proxy'])
    expect(result.kind).toBe('usage-error')
  })

  it('duplicate inline flag → usage-error', () => {
    const result = parseServerRunArgs([
      '--json',
      '--external-url=https://a.example.com',
      '--external-url=https://b.example.com',
    ])
    expect(result.kind).toBe('usage-error')
    if (result.kind !== 'usage-error') return
    expect(result.message).toContain('--external-url')
  })

  it.each([
    '--external-url',
    '--allowed-origins',
    '--auth-strategy',
    '--jwt-issuer',
    '--jwt-audience',
    '--jwks-uri',
    '--jwt-clock-skew',
    '--jwt-scope-claim',
    '--host',
    '--port',
    '--data-dir',
  ])('space form %s → usage-error with inline-form message', (flag) => {
    const result = parseServerRunArgs(['--json', flag])
    expect(result.kind).toBe('usage-error')
    if (result.kind !== 'usage-error') return
    expect(result.message).toContain('inline form')
    expect(result.message).toContain(flag)
  })

  it('empty value in inline flag → usage-error', () => {
    const result = parseServerRunArgs(['--json', '--external-url='])
    expect(result.kind).toBe('usage-error')
    if (result.kind !== 'usage-error') return
    expect(result.message).toContain('non-empty')
  })

  it('unknown flag → usage-error (value redacted)', () => {
    const result = parseServerRunArgs(['--json', '--unknown-flag=secret-value'])
    expect(result.kind).toBe('usage-error')
    if (result.kind !== 'usage-error') return
    expect(result.message).toContain('Unknown argument')
    expect(result.message).not.toContain('secret-value')
    expect(result.message).toContain('--unknown-flag=…')
  })

  it('unknown flag without value → usage-error', () => {
    const result = parseServerRunArgs(['--json', '--unknown-flag'])
    expect(result.kind).toBe('usage-error')
    if (result.kind !== 'usage-error') return
    expect(result.message).toContain('Unknown argument')
  })

  it('bare positional argument → usage-error, raw value not in message', () => {
    const result = parseServerRunArgs(['--json', 'secret-token-XYZ'])
    expect(result.kind).toBe('usage-error')
    if (result.kind !== 'usage-error') return
    expect(result.message).toContain('Unknown argument')
    expect(result.message).not.toContain('secret-token-XYZ')
    expect(result.message).toContain('[REDACTED_ARGUMENT]')
  })
})
