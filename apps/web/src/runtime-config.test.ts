import { describe, expect, it } from 'vitest'
import {
  EMPTY_RUNTIME_CONFIG,
  resolveHostedRuntimeConfig,
  resolveRuntimeConfig,
  runtimeConfigSchema,
} from './runtime-config.js'
import { isProductionPagesOrigin } from './lib/pages-origin-policy.js'

describe('runtimeConfigSchema', () => {
  it('parses an empty object as a valid config', () => {
    expect(() => resolveRuntimeConfig({})).not.toThrow()
  })

  it('parses config with a valid publicOrigin', () => {
    const config = resolveRuntimeConfig({ publicOrigin: 'https://app.example.com' })
    expect(config.publicOrigin).toBe('https://app.example.com')
  })

  it('parses config with a valid daemonBaseUrl including explicit port', () => {
    const config = resolveRuntimeConfig({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(config.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })

  it('rejects a non-URL string', () => {
    expect(() => resolveRuntimeConfig({ publicOrigin: 'not-a-url' })).toThrow()
  })

  it('rejects publicOrigin with a path component', () => {
    expect(() => resolveRuntimeConfig({ publicOrigin: 'https://app.example.com/path' })).toThrow()
  })

  it('rejects publicOrigin with a query string', () => {
    expect(() => resolveRuntimeConfig({ publicOrigin: 'https://app.example.com?token=x' })).toThrow()
  })

  it('rejects publicOrigin with a fragment', () => {
    expect(() => resolveRuntimeConfig({ publicOrigin: 'https://app.example.com#frag' })).toThrow()
  })

  it('rejects publicOrigin with credentials', () => {
    expect(() => resolveRuntimeConfig({ publicOrigin: 'https://user:pass@example.com' })).toThrow()
  })

  it('rejects wildcard hostname', () => {
    expect(() => resolveRuntimeConfig({ publicOrigin: 'https://*.example.com' })).toThrow()
  })

  it('rejects unknown keys (credential-bearing config is fail-closed)', () => {
    expect(() => resolveRuntimeConfig({ daemonBaseUrl: 'http://127.0.0.1:3099', token: 'secret' })).toThrow()
  })

  it('rejects config with Authorization key', () => {
    expect(() => resolveRuntimeConfig({ Authorization: 'Bearer tok' })).toThrow()
  })

  it('explicit default port 443 is rejected (URL.origin normalizes it away)', () => {
    expect(() => resolveRuntimeConfig({ publicOrigin: 'https://app.example.com:443' })).toThrow()
  })

  it('type is derived from runtimeConfigSchema via z.infer<>', () => {
    const config = runtimeConfigSchema.parse({ publicOrigin: 'https://app.example.com' })
    expect(config.publicOrigin).toBe('https://app.example.com')
  })

  it('EMPTY_RUNTIME_CONFIG satisfies the schema', () => {
    expect(() => runtimeConfigSchema.parse(EMPTY_RUNTIME_CONFIG)).not.toThrow()
  })
})

describe('resolveHostedRuntimeConfig', () => {
  it('accepts config without publicOrigin', () => {
    expect(() => resolveHostedRuntimeConfig({})).not.toThrow()
  })

  it('accepts production pages.dev publicOrigin', () => {
    const config = resolveHostedRuntimeConfig({ publicOrigin: 'https://whiteboard.pages.dev' })
    expect(config.publicOrigin).toBe('https://whiteboard.pages.dev')
  })

  it('rejects preview origin as publicOrigin', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://abc123.whiteboard.pages.dev' }),
    ).toThrow()
  })

  it('rejects localhost as publicOrigin', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://localhost:5173' }),
    ).toThrow()
  })

  it('rejects custom domain as publicOrigin (deferred)', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://custom.example.com' }),
    ).toThrow()
  })

  it('error message is a safe generic copy — does not expose raw publicOrigin value', () => {
    let message = ''
    try {
      resolveHostedRuntimeConfig({ publicOrigin: 'https://secret-preview.whiteboard.pages.dev' })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).not.toContain('secret-preview')
    expect(message).not.toMatch(/https?:\/\//)
  })
})

describe('runtimeConfigSchema + pages origin policy cross-reference', () => {
  it('preview origin passes structural bare-origin schema', () => {
    // The schema validates shape only (bare origin, https, no wildcards).
    // A preview deploy URL is structurally valid but must NOT be used as publicOrigin.
    const config = resolveRuntimeConfig({ publicOrigin: 'https://abc123.whiteboard.pages.dev' })
    expect(config.publicOrigin).toBe('https://abc123.whiteboard.pages.dev')
  })

  it('preview origin is rejected by isProductionPagesOrigin', () => {
    expect(isProductionPagesOrigin('https://abc123.whiteboard.pages.dev')).toBe(false)
  })

  it('production origin passes both schema and pages policy', () => {
    const config = resolveRuntimeConfig({ publicOrigin: 'https://whiteboard.pages.dev' })
    expect(config.publicOrigin).toBe('https://whiteboard.pages.dev')
    expect(isProductionPagesOrigin('https://whiteboard.pages.dev')).toBe(true)
  })
})
