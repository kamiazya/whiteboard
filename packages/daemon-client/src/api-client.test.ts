import { afterEach, describe, expect, it } from 'vitest'
import { apiFetch, readRuntimeConfig, runtimeConfigSchema } from './api-client.js'
import { resetTokenStoreForTests } from './token-store.js'

describe('runtimeConfigSchema', () => {
  it('accepts a valid daemonBaseUrl', () => {
    expect(runtimeConfigSchema.parse({ daemonBaseUrl: 'http://127.0.0.1:3099' })).toEqual({
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
  })

  it('accepts an empty object', () => {
    expect(runtimeConfigSchema.parse({})).toEqual({})
  })

  it('rejects a non-string daemonBaseUrl', () => {
    expect(() => runtimeConfigSchema.parse({ daemonBaseUrl: 42 })).toThrow()
  })

  // Mutation-check target: reverting the token-channel split to put daemonToken
  // back inside this object must make this assertion fail — .strict() is what
  // makes that regression visible instead of silently dropping the extra key.
  it('rejects a payload that still carries daemonToken (.strict() rejection, not silent drop)', () => {
    expect(runtimeConfigSchema.safeParse({ daemonToken: 'secret' }).success).toBe(false)
  })

  // Single-owner fold (was apps/web's separate, stricter schema): the wire
  // contract carries publicOrigin alongside daemonBaseUrl, and both fields
  // are bare-origin-validated everywhere they are read, not just in apps/web.
  it('accepts a payload carrying a production publicOrigin', () => {
    expect(runtimeConfigSchema.safeParse({ publicOrigin: 'https://app.example.com' }).success).toBe(
      true,
    )
  })

  it('accepts publicOrigin and daemonBaseUrl together', () => {
    expect(
      runtimeConfigSchema.safeParse({
        publicOrigin: 'https://app.example.com',
        daemonBaseUrl: 'http://127.0.0.1:3099',
      }).success,
    ).toBe(true)
  })

  it('rejects a daemonBaseUrl that is not a bare origin (trailing slash)', () => {
    expect(runtimeConfigSchema.safeParse({ daemonBaseUrl: 'http://127.0.0.1:3099/' }).success).toBe(
      false,
    )
  })

  it('rejects a daemonBaseUrl carrying a path', () => {
    expect(
      runtimeConfigSchema.safeParse({ daemonBaseUrl: 'http://127.0.0.1:3099/pair' }).success,
    ).toBe(false)
  })
})

describe('readRuntimeConfig', () => {
  it('falls back to the token-free default when window is not defined', () => {
    expect(readRuntimeConfig()).toEqual({})
  })

  it('falls back to the token-free default when the injected global fails schema validation', () => {
    const fakeWindow = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_RUNTIME_CONFIG__: { daemonToken: 'secret' },
    }
    ;(globalThis as { window?: unknown }).window = fakeWindow
    try {
      expect(readRuntimeConfig()).toEqual({})
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  it('returns the injected daemonBaseUrl when it passes schema validation', () => {
    const fakeWindow = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_RUNTIME_CONFIG__: { daemonBaseUrl: 'http://127.0.0.1:3099' },
    }
    ;(globalThis as { window?: unknown }).window = fakeWindow
    try {
      expect(readRuntimeConfig()).toEqual({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})

describe('apiFetch auth header (TokenStore-sourced)', () => {
  afterEach(() => {
    resetTokenStoreForTests()
    delete (globalThis as { window?: unknown }).window
  })

  it('attaches Authorization from the TokenStore token, ignoring any daemonToken on the runtime-config global', async () => {
    let capturedHeaders: Headers | undefined
    const fakeWindow = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_RUNTIME_CONFIG__: { daemonToken: 'ignored-config-token' },
      __WHITEBOARD_DAEMON_TOKEN__: 'store-token',
    }
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return Promise.resolve(new Response('ok'))
    }) as typeof fetch
    try {
      await apiFetch('http://localhost/api/workspaces')
      expect(capturedHeaders?.get('Authorization')).toBe('Bearer store-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
