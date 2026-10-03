import { propagation } from '@opentelemetry/api'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apiFetch, runtimeConfigSchema } from './api-client.js'

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

// ADR-0050: the page holds no daemon credential, so nothing it finds on the
// window becomes one.
describe('apiFetch auth header', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('attaches no Authorization, whatever the window carries', async () => {
    let capturedHeaders: Headers | undefined
    ;(globalThis as { window?: unknown }).window = {
      location: { origin: 'https://localhost' },
      __WHITEBOARD_DAEMON_TOKEN__: 'injected-token',
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return Promise.resolve(new Response('ok'))
    }) as typeof fetch
    try {
      await apiFetch('https://localhost/api/workspaces')
      expect(capturedHeaders?.has('Authorization')).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('apiFetch trace context', () => {
  const realFetch = globalThis.fetch
  const TRACEPARENT = '00-aaaa-bbbb-01'

  // A propagator that stamps a header, standing in for a registered SDK.
  beforeAll(() => {
    propagation.setGlobalPropagator({
      inject(_ctx, carrier, setter) {
        setter.set(carrier, 'traceparent', TRACEPARENT)
      },
      extract: (ctx) => ctx,
      fields: () => ['traceparent'],
    })
  })
  afterAll(() => propagation.disable())
  afterEach(() => {
    globalThis.fetch = realFetch
    delete (globalThis as { window?: unknown }).window
  })

  function capture(withWindow = true): Headers[] {
    if (withWindow) {
      ;(globalThis as { window?: unknown }).window = { location: { origin: 'https://localhost' } }
    }
    const seen: Headers[] = []
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      seen.push(
        new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      )
      return Promise.resolve(new Response('ok'))
    }) as typeof fetch
    return seen
  }

  it('stamps an absolute same-origin /api/ request', async () => {
    const seen = capture()
    await apiFetch('https://localhost/api/workspaces')
    expect(seen[0]?.get('traceparent')).toBe(TRACEPARENT)
  })

  it('stamps a relative /api/ path', async () => {
    const seen = capture()
    await apiFetch('/api/workspaces')
    expect(seen[0]?.get('traceparent')).toBe(TRACEPARENT)
  })

  it('never stamps a cross-origin request', async () => {
    const seen = capture()
    await apiFetch('https://third-party.example/api/x')
    expect(seen[0]?.has('traceparent')).toBe(false)
  })

  it('never stamps a same-origin request outside /api/', async () => {
    const seen = capture()
    await apiFetch('https://localhost/assets/app.js')
    expect(seen[0]?.has('traceparent')).toBe(false)
  })

  it('classifies a URL object and a Request by the same origin and path rule', async () => {
    const seen = capture()
    await apiFetch(new URL('https://localhost/api/a'))
    await apiFetch(new Request('https://localhost/api/b'))
    await apiFetch(new Request('https://third-party.example/api/c'))
    expect(seen[0]?.get('traceparent')).toBe(TRACEPARENT)
    expect(seen[1]?.get('traceparent')).toBe(TRACEPARENT)
    expect(seen[2]?.has('traceparent')).toBe(false)
  })

  it("keeps a Request input's own headers when init carries none", async () => {
    const seen = capture()
    await apiFetch(new Request('https://localhost/api/b', { headers: { 'x-keep': '1' } }))
    expect(seen[0]?.get('x-keep')).toBe('1')
  })

  it('lets init.headers replace the Request input headers', async () => {
    const seen = capture()
    await apiFetch(new Request('https://localhost/api/b', { headers: { 'x-keep': '1' } }), {
      headers: { 'x-other': '2' },
    })
    expect(seen[0]?.get('x-other')).toBe('2')
    expect(seen[0]?.has('x-keep')).toBe(false)
  })

  it('resolves a bare path against localhost when there is no window', async () => {
    const seen = capture(false)
    await apiFetch('/api/x')
    expect(seen[0]?.get('traceparent')).toBe(TRACEPARENT)
  })
})
