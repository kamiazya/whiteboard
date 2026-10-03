import { runtimeConfigSchema as sharedRuntimeConfigSchema } from '@kamiazya/whiteboard-daemon-client/api-client'
import { describe, expect, it } from 'vitest'
import { classifyPagesOrigin } from './lib/pages-origin-policy.js'
import {
  RuntimeConfigPolicyError,
  resolveHostedRuntimeConfig,
  runtimeConfigSchema,
} from './runtime-config.js'

describe('single-owner schema (Zod discipline)', () => {
  // Mutation-check target: restoring a local `z.object({...})` definition in
  // runtime-config.ts (instead of re-exporting the shared schema) must make
  // this fail — a structurally-equal-but-distinct schema is exactly the
  // silent-drift shape this pin exists to catch.
  it('re-exports the same schema instance as @kamiazya/whiteboard-daemon-client/api-client', () => {
    expect(runtimeConfigSchema).toBe(sharedRuntimeConfigSchema)
  })
})

describe('runtimeConfigSchema', () => {
  it('parses an empty object as a valid config', () => {
    expect(() => runtimeConfigSchema.parse({})).not.toThrow()
  })

  it('parses config with a valid publicOrigin', () => {
    const config = runtimeConfigSchema.parse({ publicOrigin: 'https://app.example.com' })
    expect(config.publicOrigin).toBe('https://app.example.com')
  })

  it('parses config with a valid daemonBaseUrl including explicit port', () => {
    const config = runtimeConfigSchema.parse({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(config.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })

  it('rejects a non-URL string', () => {
    expect(() => runtimeConfigSchema.parse({ publicOrigin: 'not-a-url' })).toThrow()
  })

  it('rejects publicOrigin with a path component', () => {
    expect(() =>
      runtimeConfigSchema.parse({ publicOrigin: 'https://app.example.com/path' }),
    ).toThrow()
  })

  it('rejects publicOrigin with a query string', () => {
    expect(() =>
      runtimeConfigSchema.parse({ publicOrigin: 'https://app.example.com?token=x' }),
    ).toThrow()
  })

  it('rejects publicOrigin with a fragment', () => {
    expect(() =>
      runtimeConfigSchema.parse({ publicOrigin: 'https://app.example.com#frag' }),
    ).toThrow()
  })

  it('rejects publicOrigin with credentials', () => {
    expect(() =>
      runtimeConfigSchema.parse({ publicOrigin: 'https://user:pass@example.com' }),
    ).toThrow()
  })

  it('rejects wildcard hostname', () => {
    expect(() => runtimeConfigSchema.parse({ publicOrigin: 'https://*.example.com' })).toThrow()
  })

  it('rejects unknown keys (credential-bearing config is fail-closed)', () => {
    expect(() =>
      runtimeConfigSchema.parse({ daemonBaseUrl: 'http://127.0.0.1:3099', token: 'secret' }),
    ).toThrow()
  })

  it('rejects config with Authorization key', () => {
    expect(() => runtimeConfigSchema.parse({ Authorization: 'Bearer tok' })).toThrow()
  })

  // Mutation-check target: the daemon auth token travels via its own global
  // (window.__WHITEBOARD_DAEMON_TOKEN__), never inside this config object.
  // Reverting that split — putting daemonToken back into the injected config —
  // must make this assertion fail.
  it('rejects a payload containing daemonToken (.strict() rejection of the token channel)', () => {
    expect(runtimeConfigSchema.safeParse({ daemonToken: 'secret' }).success).toBe(false)
    expect(() =>
      runtimeConfigSchema.parse({ daemonBaseUrl: 'http://127.0.0.1:3099', daemonToken: 'secret' }),
    ).toThrow()
  })

  it('parses the split shape: a token-free config with daemonBaseUrl only', () => {
    const config = runtimeConfigSchema.parse({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(config).toEqual({ daemonBaseUrl: 'http://127.0.0.1:3099' })
  })

  it('explicit default port 443 is rejected (URL.origin normalizes it away)', () => {
    expect(() =>
      runtimeConfigSchema.parse({ publicOrigin: 'https://app.example.com:443' }),
    ).toThrow()
  })

  it('type is derived from runtimeConfigSchema via z.infer<>', () => {
    const config = runtimeConfigSchema.parse({ publicOrigin: 'https://app.example.com' })
    expect(config.publicOrigin).toBe('https://app.example.com')
  })
})

describe('resolveHostedRuntimeConfig', () => {
  it('accepts config without publicOrigin', () => {
    expect(() => resolveHostedRuntimeConfig({})).not.toThrow()
  })

  it('accepts production pages.dev publicOrigin', () => {
    const config = resolveHostedRuntimeConfig({
      publicOrigin: 'https://kamiazya-whiteboard.pages.dev',
    })
    expect(config.publicOrigin).toBe('https://kamiazya-whiteboard.pages.dev')
  })

  it('rejects preview origin as publicOrigin', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://abc123.kamiazya-whiteboard.pages.dev' }),
    ).toThrow()
  })

  it('rejects localhost as publicOrigin', () => {
    expect(() => resolveHostedRuntimeConfig({ publicOrigin: 'https://localhost:5173' })).toThrow()
  })

  it('rejects custom domain as publicOrigin (deferred)', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://custom.example.com' }),
    ).toThrow()
  })

  it('rejects custom domain publicOrigin with a RuntimeConfigPolicyError explaining it is unsupported', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://custom.example.com' }),
    ).toThrow(RuntimeConfigPolicyError)
    try {
      resolveHostedRuntimeConfig({ publicOrigin: 'https://custom.example.com' })
      expect.unreachable('expected resolveHostedRuntimeConfig to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(RuntimeConfigPolicyError)
      const message = e instanceof Error ? e.message : String(e)
      expect(message).toMatch(/custom domain/i)
      expect(message).toMatch(/not (yet )?supported/i)
    }
  })

  it('rejects the production host on a non-default port as a custom domain, not as production', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://kamiazya-whiteboard.pages.dev:8443' }),
    ).toThrow(/custom domain/i)
  })

  it('rejects a host that merely ends in the pages domain as a custom domain, not as a preview', () => {
    expect(() =>
      resolveHostedRuntimeConfig({ publicOrigin: 'https://notkamiazya-whiteboard.pages.dev' }),
    ).toThrow(/custom domain/i)
  })

  it('rejects the IPv6 loopback with the generic copy, as it does every loopback', () => {
    expect(() => resolveHostedRuntimeConfig({ publicOrigin: 'https://[::1]:5173' })).toThrow(
      RuntimeConfigPolicyError,
    )
    expect(() => resolveHostedRuntimeConfig({ publicOrigin: 'https://[::1]:5173' })).not.toThrow(
      /custom domain/i,
    )
  })

  it('custom domain rejection message does not expose the raw origin value', () => {
    let message = ''
    try {
      resolveHostedRuntimeConfig({ publicOrigin: 'https://secret.example.com' })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).not.toContain('secret')
    expect(message).not.toMatch(/https?:\/\//)
  })

  it('error message is a safe generic copy — does not expose raw publicOrigin value', () => {
    let message = ''
    try {
      resolveHostedRuntimeConfig({
        publicOrigin: 'https://secret-preview.kamiazya-whiteboard.pages.dev',
      })
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
    const config = runtimeConfigSchema.parse({
      publicOrigin: 'https://abc123.kamiazya-whiteboard.pages.dev',
    })
    expect(config.publicOrigin).toBe('https://abc123.kamiazya-whiteboard.pages.dev')
  })

  it('preview origin is classified as a preview, never production', () => {
    expect(classifyPagesOrigin('https://abc123.kamiazya-whiteboard.pages.dev')).toBe('preview')
  })

  it('production origin passes both schema and pages policy', () => {
    const config = runtimeConfigSchema.parse({
      publicOrigin: 'https://kamiazya-whiteboard.pages.dev',
    })
    expect(config.publicOrigin).toBe('https://kamiazya-whiteboard.pages.dev')
    expect(classifyPagesOrigin('https://kamiazya-whiteboard.pages.dev')).toBe('production')
  })
})
