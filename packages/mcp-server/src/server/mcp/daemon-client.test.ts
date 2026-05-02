import { describe, expect, it, vi } from 'vitest'

const { createDaemonClient } = await import('./daemon-client.js')

describe('createDaemonClient', () => {
  it('request builds URLs from baseUrl and attaches bearer auth', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://127.0.0.1:3099/api/workspaces/demo/canvases')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toBeInstanceOf(Headers)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof globalThis.fetch

    try {
      const client = createDaemonClient({
        baseUrl: 'http://127.0.0.1:3099',
        port: 3099,
        token: 'secret-token',
      })
      const res = await client.request('/api/workspaces/demo/canvases', { method: 'POST' })
      expect(res.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('touch posts to the authenticated runtime endpoint', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://127.0.0.1:3099/api/runtime/touch')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof globalThis.fetch

    try {
      const client = createDaemonClient({
        baseUrl: 'http://127.0.0.1:3099',
        port: 3099,
        token: 'secret-token',
      })
      await expect(client.touch()).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
