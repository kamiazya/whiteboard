import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTokenStoreForTests } from '../../shared/token-store.js'

const { apiFetch } = await import('./api-client.js')

describe('apiFetch', () => {
  let originalFetch: typeof globalThis.fetch
  let originalWindow: typeof globalThis.window | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalWindow = globalThis.window
    resetTokenStoreForTests()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    })
    resetTokenStoreForTests()
  })

  it('attaches the daemon bearer token to local API requests', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: { origin: 'http://localhost:3099' },
        __WHITEBOARD_DAEMON_TOKEN__: 'secret',
      },
      configurable: true,
      writable: true,
    })
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
      return new Response(null, { status: 200 })
    }) as typeof globalThis.fetch

    const res = await apiFetch('/api/workspaces/session1/canvases', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('does not attach the daemon token to external requests', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: { origin: 'http://localhost:3099' },
        __WHITEBOARD_DAEMON_TOKEN__: 'secret',
      },
      configurable: true,
      writable: true,
    })
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      return new Response(null, { status: 200 })
    }) as typeof globalThis.fetch

    const res = await apiFetch('https://example.com/library.excalidrawlib')
    expect(res.status).toBe(200)
  })
})
