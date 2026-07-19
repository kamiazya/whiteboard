import { readDaemonTokenOnce, resetTokenStoreForTests } from '@kamiazya/whiteboard-mcp/api-client'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clear as clearSecretStore, load, save } from '../lib/reconnect-credential-store.js'
import type { ReconnectKeypairRecord } from '../lib/reconnect-keypair-store.js'
import {
  resetSilentReconnectForTests,
  type UseSilentReconnectDeps,
  useSilentReconnect,
} from './useSilentReconnect.js'

const ORIGIN = 'http://localhost:3099'

const FAKE_PUBLIC_KEY = {} as CryptoKey
const FAKE_PRIVATE_KEY = {} as CryptoKey
const FAKE_KEY_ID = 'key-id-1'

function fakeKeypair(
  status: ReconnectKeypairRecord['status'] = 'confirmed',
): ReconnectKeypairRecord {
  return {
    v: 1,
    origin: ORIGIN,
    keyId: FAKE_KEY_ID,
    status,
    publicKey: FAKE_PUBLIC_KEY,
    privateKey: FAKE_PRIVATE_KEY,
  }
}

// No keypair enrolled (jsdom has no real IndexedDB / WebCrypto anyway — see
// reconnect-keypair-store.browser.test.tsx for the real persistence + signing
// round trip). This DI seam lets these tests drive the legacy-secret and
// keypair-rejected fallback branches deterministically.
function makeDeps(overrides: Partial<UseSilentReconnectDeps> = {}): UseSilentReconnectDeps {
  return {
    loadKeypair: vi.fn(async () => null),
    markKeypairConfirmed: vi.fn(async () => {}),
    clearKeypair: vi.fn(async () => {}),
    signReconnectNonce: vi.fn(async () => 'signature-1'),
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  clearSecretStore()
  resetSilentReconnectForTests()
  resetTokenStoreForTests()
  vi.restoreAllMocks()
})

describe('useSilentReconnect', () => {
  it('stays idle and makes zero fetches when disabled', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = vi.fn()
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: false, origin: ORIGIN, fetchImpl: fetchMock, deps }),
    )
    expect(result.current).toEqual({ status: 'idle' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays idle and makes zero fetches when there is no keypair and no stored secret', async () => {
    const fetchMock = vi.fn()
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
    )
    await waitFor(() => expect(result.current).toEqual({ status: 'idle' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('legacy secret path (no keypair enrolled)', () => {
    it('happy path: connecting -> connected, seeds the token store, keeps the secret (no rotation)', async () => {
      save(ORIGIN, 'secret-1')
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
        jsonResponse({ token: 'daemon-token' }),
      )
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useSilentReconnect({
          enabled: true,
          origin: ORIGIN,
          fetchImpl: fetchMock,
          deps,
        }),
      )
      await waitFor(() => expect(result.current.status).toBe('connected'))
      expect(result.current).toEqual({ status: 'connected', token: 'daemon-token' })
      expect(load(ORIGIN)).toBe('secret-1')
      expect(readDaemonTokenOnce()).toBe('daemon-token')
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toBe(`${ORIGIN}/api/reconnect-session`)
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        'Bearer secret-1',
      )
    })

    it('403 clears the stored secret and reports failed(rejected)', async () => {
      save(ORIGIN, 'secret-1')
      const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 403))
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useSilentReconnect({
          enabled: true,
          origin: ORIGIN,
          fetchImpl: fetchMock,
          deps,
        }),
      )
      await waitFor(() => expect(result.current.status).toBe('failed'))
      expect(result.current).toEqual({ status: 'failed', reason: 'rejected' })
      expect(load(ORIGIN)).toBeNull()
    })

    it('a pre-migration daemon rotating the legacy secret persists the replacement', async () => {
      save(ORIGIN, 'secret-1')
      const fetchMock = vi.fn(async () =>
        jsonResponse({ token: 'daemon-token', reconnectSecret: 'secret-2', expiresInDays: 30 }),
      )
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useSilentReconnect({
          enabled: true,
          origin: ORIGIN,
          fetchImpl: fetchMock,
          deps,
        }),
      )
      await waitFor(() => expect(result.current.status).toBe('connected'))
      expect(result.current).toEqual({ status: 'connected', token: 'daemon-token' })
      expect(load(ORIGIN)).toBe('secret-2')
    })

    it('network error keeps the stored secret and reports failed(network)', async () => {
      save(ORIGIN, 'secret-1')
      const fetchMock = vi.fn(async () => {
        throw new Error('offline')
      })
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useSilentReconnect({
          enabled: true,
          origin: ORIGIN,
          fetchImpl: fetchMock,
          deps,
        }),
      )
      await waitFor(() => expect(result.current.status).toBe('failed'))
      expect(result.current).toEqual({ status: 'failed', reason: 'network' })
      expect(load(ORIGIN)).toBe('secret-1')
    })

    it('StrictMode-style double-mount for the same (origin, secret) makes exactly one network call', async () => {
      save(ORIGIN, 'secret-1')
      const fetchMock = vi.fn(async () => jsonResponse({ token: 'daemon-token' }))
      const deps = makeDeps()
      const first = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )
      const second = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(first.result.current.status).toBe('connected'))
      await waitFor(() => expect(second.result.current.status).toBe('connected'))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('a late completion after disable does not flip UI state', async () => {
      save(ORIGIN, 'secret-1')
      let resolveFetch: ((value: Response) => void) | undefined
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          }),
      )
      const deps = makeDeps()
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useSilentReconnect({ enabled, origin: ORIGIN, fetchImpl: fetchMock, deps }),
        { initialProps: { enabled: true } },
      )
      await waitFor(() => expect(result.current).toEqual({ status: 'connecting' }))

      rerender({ enabled: false })
      expect(result.current).toEqual({ status: 'idle' })

      await act(async () => {
        resolveFetch?.(jsonResponse({ token: 'daemon-token' }))
        await Promise.resolve()
        await Promise.resolve()
      })

      // UI state is unaffected by the stale generation, and the token store
      // must not be seeded by a completion for a superseded (enabled, origin).
      expect(result.current).toEqual({ status: 'idle' })
      expect(readDaemonTokenOnce()).toBeNull()
    })

    it('a late completion after unmount does not seed the token store', async () => {
      save(ORIGIN, 'secret-1')
      let resolveFetch: ((value: Response) => void) | undefined
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          }),
      )
      const deps = makeDeps()
      const { result, unmount } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )
      await waitFor(() => expect(result.current).toEqual({ status: 'connecting' }))

      unmount()

      await act(async () => {
        resolveFetch?.(jsonResponse({ token: 'daemon-token' }))
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(readDaemonTokenOnce()).toBeNull()
    })
  })

  describe('keypair path (enrolled)', () => {
    it('happy path: challenges, signs the nonce, redeems the token, and confirms a pending keypair', async () => {
      const deps = makeDeps({ loadKeypair: vi.fn(async () => fakeKeypair('pending')) })
      save(ORIGIN, 'legacy-secret') // must be cleared once the keypair login succeeds
      const fetchMock = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/api/reconnect-challenge')) {
          return jsonResponse({ challengeId: 'c-1', nonce: 'nonce-1', expiresInSeconds: 60 })
        }
        return jsonResponse({ token: 'daemon-token' })
      })

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('connected'))
      expect(result.current).toEqual({ status: 'connected', token: 'daemon-token' })
      expect(deps.signReconnectNonce).toHaveBeenCalledWith(FAKE_PRIVATE_KEY, 'nonce-1')
      expect(deps.markKeypairConfirmed).toHaveBeenCalledWith(ORIGIN)
      expect(load(ORIGIN)).toBeNull()
      expect(readDaemonTokenOnce()).toBe('daemon-token')
    })

    it("a pending keypair success does not erase a DIFFERENT origin's legacy secret (cross-origin race)", async () => {
      const OTHER_ORIGIN = 'http://localhost:4000'
      const deps = makeDeps({ loadKeypair: vi.fn(async () => fakeKeypair('pending')) })
      // Simulates another tab having saved a legacy secret for a different
      // origin after this attempt started but before it completes.
      save(OTHER_ORIGIN, 'other-origin-secret')
      const fetchMock = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/api/reconnect-challenge')) {
          return jsonResponse({ challengeId: 'c-1', nonce: 'nonce-1', expiresInSeconds: 60 })
        }
        return jsonResponse({ token: 'daemon-token' })
      })

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('connected'))
      expect(load(OTHER_ORIGIN)).toBe('other-origin-secret')
    })

    it('an already-confirmed keypair does not re-confirm or touch the legacy secret store', async () => {
      const deps = makeDeps({ loadKeypair: vi.fn(async () => fakeKeypair('confirmed')) })
      const fetchMock = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/api/reconnect-challenge')) {
          return jsonResponse({ challengeId: 'c-1', nonce: 'nonce-1', expiresInSeconds: 60 })
        }
        return jsonResponse({ token: 'daemon-token' })
      })

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('connected'))
      expect(deps.markKeypairConfirmed).not.toHaveBeenCalled()
    })

    it('a rejected keypair is cleared and falls back to a legacy secret', async () => {
      const deps = makeDeps({ loadKeypair: vi.fn(async () => fakeKeypair('confirmed')) })
      save(ORIGIN, 'legacy-secret')
      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith('/api/reconnect-challenge')) {
          return jsonResponse({ challengeId: 'c-1', nonce: 'nonce-1', expiresInSeconds: 60 })
        }
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
        if (auth === 'Bearer legacy-secret') {
          return jsonResponse({ token: 'daemon-token' })
        }
        return jsonResponse({ error: 'unauthorized' }, 403)
      })

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('connected'))
      expect(result.current).toEqual({ status: 'connected', token: 'daemon-token' })
      expect(deps.clearKeypair).toHaveBeenCalledWith(ORIGIN, FAKE_KEY_ID)
      // Legacy secret survives — it was the successful fallback credential.
      expect(load(ORIGIN)).toBe('legacy-secret')
    })

    it('a rejected keypair with no legacy secret reports failed(rejected)', async () => {
      const deps = makeDeps({ loadKeypair: vi.fn(async () => fakeKeypair('confirmed')) })
      const fetchMock = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/api/reconnect-challenge')) {
          return jsonResponse({ challengeId: 'c-1', nonce: 'nonce-1', expiresInSeconds: 60 })
        }
        return jsonResponse({ error: 'unauthorized' }, 403)
      })

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('failed'))
      expect(result.current).toEqual({ status: 'failed', reason: 'rejected' })
      expect(deps.clearKeypair).toHaveBeenCalledWith(ORIGIN, FAKE_KEY_ID)
    })

    it('a rejected signing operation reports failed(network) instead of hanging in connecting', async () => {
      const deps = makeDeps({
        loadKeypair: vi.fn(async () => fakeKeypair('confirmed')),
        signReconnectNonce: vi.fn(async () => {
          throw new DOMException('key usage mismatch', 'InvalidAccessError')
        }),
      })
      const fetchMock = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/api/reconnect-challenge')) {
          return jsonResponse({ challengeId: 'c-1', nonce: 'nonce-1', expiresInSeconds: 60 })
        }
        return jsonResponse({ token: 'daemon-token' })
      })

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('failed'))
      expect(result.current).toEqual({ status: 'failed', reason: 'network' })
    })

    it('a rejected loadKeypair (e.g. IndexedDB open failure) falls back to a legacy secret instead of surfacing the throw', async () => {
      const deps = makeDeps({
        loadKeypair: vi.fn(async () => {
          throw new Error('IndexedDB open failed')
        }),
      })
      save(ORIGIN, 'legacy-secret')
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
        jsonResponse({ token: 'daemon-token' }),
      )

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('connected'))
      expect(result.current).toEqual({ status: 'connected', token: 'daemon-token' })
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toBe(`${ORIGIN}/api/reconnect-session`)
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        'Bearer legacy-secret',
      )
    })

    it('a rejected loadKeypair with no legacy secret stays idle rather than reporting failed', async () => {
      const deps = makeDeps({
        loadKeypair: vi.fn(async () => {
          throw new Error('IndexedDB open failed')
        }),
      })
      const fetchMock = vi.fn()

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current).toEqual({ status: 'idle' }))
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a network error on the keypair path does NOT fall back to a legacy secret', async () => {
      const deps = makeDeps({ loadKeypair: vi.fn(async () => fakeKeypair('confirmed')) })
      save(ORIGIN, 'legacy-secret')
      const fetchMock = vi.fn(async () => {
        throw new Error('offline')
      })

      const { result } = renderHook(() =>
        useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock, deps }),
      )

      await waitFor(() => expect(result.current.status).toBe('failed'))
      expect(result.current).toEqual({ status: 'failed', reason: 'network' })
      expect(deps.clearKeypair).not.toHaveBeenCalled()
      // Untouched — the legacy path was never attempted for a transient failure.
      expect(load(ORIGIN)).toBe('legacy-secret')
    })
  })
})
