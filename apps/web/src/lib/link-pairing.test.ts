/**
 * The decision a `#wb=` pairing link goes through now that it carries no
 * credential. Tested here rather than only through App because the branch
 * that matters most — the consent redirect — navigates the document away,
 * which a mounted-app test cannot observe without stubbing the thing under
 * test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLinkPairing } from './link-pairing.js'

const PAYLOAD = {
  baseUrl: 'http://127.0.0.1:3099',
  workspaceId: 'ws1',
  path: 'canvas-a',
} as const

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    map,
  }
}

describe('resolveLinkPairing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves without leaving the page when this origin already holds a grant', async () => {
    const navigate = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'session-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            origin: 'https://app.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof globalThis.fetch

    const outcome = await resolveLinkPairing({
      payload: PAYLOAD,
      fetch,
      hostedOrigin: 'https://app.example.com',
      sessionStorage: memoryStorage(),
      navigate,
    })

    expect(outcome).toEqual({
      kind: 'resolved',
      grant: {
        status: 'paired',
        daemonBaseUrl: 'http://127.0.0.1:3099',
        token: 'session-token',
      },
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('sends the browser to the daemon’s own /pair page when there is no grant yet', async () => {
    const navigate = vi.fn()
    const storage = memoryStorage()
    const fetch = vi.fn(
      async () => new Response('{}', { status: 403 }),
    ) as unknown as typeof globalThis.fetch

    const outcome = await resolveLinkPairing({
      payload: PAYLOAD,
      fetch,
      hostedOrigin: 'https://app.example.com',
      sessionStorage: storage,
      navigate,
    })

    expect(outcome).toEqual({ kind: 'redirecting' })
    const target = new URL(navigate.mock.calls[0][0] as string)
    expect(target.origin).toBe('http://127.0.0.1:3099')
    expect(target.pathname).toBe('/pair')
    expect(target.searchParams.get('origin')).toBe('https://app.example.com')
    // PKCE: a challenge goes out, and the verifier stays behind.
    expect(target.searchParams.get('challenge')).toBeTruthy()
    expect(navigate.mock.calls[0][0]).not.toContain(
      JSON.parse(storage.map.get('whiteboard:pairing-transaction') as string).codeVerifier,
    )
  })

  // The link names what to open; the consent hop is a full navigation, so
  // the only way that survives is the stashed transaction.
  it('stashes the link target so it survives the consent navigation', async () => {
    const storage = memoryStorage()
    const fetch = vi.fn(
      async () => new Response('{}', { status: 403 }),
    ) as unknown as typeof globalThis.fetch

    await resolveLinkPairing({
      payload: { ...PAYLOAD, fullscreen: true },
      fetch,
      hostedOrigin: 'https://app.example.com',
      sessionStorage: storage,
      navigate: vi.fn(),
    })

    const stashed = JSON.parse(storage.map.get('whiteboard:pairing-transaction') as string)
    expect(stashed.target).toEqual({ workspaceId: 'ws1', path: 'canvas-a', fullscreen: true })
    expect(stashed.daemonBaseUrl).toBe('http://127.0.0.1:3099')
  })

  // An identity mismatch means a pinned daemon answered with the wrong key.
  // Redirecting to /pair would re-pin exactly the key that just failed, so
  // it has to come back as a resolution the caller can warn about.
  it('reports an identity mismatch instead of redirecting into a re-pin', async () => {
    const navigate = vi.fn()
    localStorage.setItem(
      'whiteboard:daemon-identity-pins',
      JSON.stringify({
        'http://127.0.0.1:3099': {
          alg: 'Ed25519',
          publicKey: 'pinned-key',
          pinnedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'session-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            origin: 'https://app.example.com',
            identity: { alg: 'Ed25519', publicKey: 'a-different-key', signature: 'nope' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof globalThis.fetch

    const outcome = await resolveLinkPairing({
      payload: PAYLOAD,
      fetch,
      hostedOrigin: 'https://app.example.com',
      sessionStorage: memoryStorage(),
      navigate,
    })

    expect(outcome).toEqual({
      kind: 'resolved',
      grant: { status: 'identity-mismatch', daemonBaseUrl: 'http://127.0.0.1:3099' },
    })
    expect(navigate).not.toHaveBeenCalled()
    localStorage.clear()
  })

  it('reports failure rather than hanging when the daemon cannot be reached at all', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof globalThis.fetch
    const navigate = vi.fn(() => {
      throw new Error('navigation blew up')
    })

    const outcome = await resolveLinkPairing({
      payload: PAYLOAD,
      fetch,
      hostedOrigin: 'https://app.example.com',
      sessionStorage: memoryStorage(),
      navigate,
    })

    expect(outcome).toEqual({ kind: 'failed' })
  })
})
