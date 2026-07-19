import type { EcP256PublicJwk } from '@kamiazya/whiteboard-mcp/api-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clear as clearSecretStore, load } from './reconnect-credential-store.js'
import {
  enrollForReconnectOnce,
  type ReconnectEnrollmentDeps,
  resetReconnectEnrollmentForTests,
} from './reconnect-enrollment.js'
import type { ReconnectKeypairRecord } from './reconnect-keypair-store.js'

const ORIGIN = 'http://localhost:3099'

const PUBLIC_JWK: EcP256PublicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}

// A CryptoKey instance is not constructible in a jsdom test — IndexedDB
// persistence and WebCrypto signing/export both belong in web-browser tests
// (see reconnect-keypair-store.browser.test.tsx). Here, only the enrollment
// orchestration/fallback branching is under test, so a fake key identity is
// enough: `deps.exportPublicJwk` never actually inspects it.
const FAKE_PUBLIC_KEY = {} as CryptoKey
const FAKE_PRIVATE_KEY = {} as CryptoKey

function fakeKeypair(status: ReconnectKeypairRecord['status'] = 'pending'): ReconnectKeypairRecord {
  return {
    v: 1,
    origin: ORIGIN,
    keyId: 'key-id-1',
    status,
    publicKey: FAKE_PUBLIC_KEY,
    privateKey: FAKE_PRIVATE_KEY,
  }
}

function makeDeps(overrides: Partial<ReconnectEnrollmentDeps> = {}): ReconnectEnrollmentDeps {
  return {
    getOrCreateKeypair: vi.fn(async () => fakeKeypair()),
    exportPublicJwk: vi.fn(async () => PUBLIC_JWK),
    clearKeypair: vi.fn(async () => {}),
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
  resetReconnectEnrollmentForTests()
})

describe('enrollForReconnectOnce', () => {
  it('generates/loads a keypair, exports its public JWK, and POSTs it', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(deps.getOrCreateKeypair).toHaveBeenCalledWith(ORIGIN)
    expect(deps.exportPublicJwk).toHaveBeenCalledWith(FAKE_PUBLIC_KEY)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({ publicKeyJwk: PUBLIC_JWK })
  })

  it('enrolls a tokenless daemon (authMode "none") by omitting the Authorization header', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, null, fetchMock, deps)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it('on a legacy daemon response, persists the returned secret (crash-safe fallback)', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async () =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    await vi.waitFor(() => expect(load(ORIGIN)).toBe('secret-1'))
  })

  it('on a legacy daemon response, clears the pending keypair so a reload prefers the legacy secret', async () => {
    // A pre-migration daemon never learns to confirm this keypair (no
    // challenge support) — if the pending record stayed, useSilentReconnect
    // would keep preferring it over the legacy secret on every reload,
    // permanently blocking the promised old-daemon fallback.
    const deps = makeDeps()
    const fetchMock = vi.fn(async () =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    await vi.waitFor(() => expect(load(ORIGIN)).toBe('secret-1'))
    expect(deps.clearKeypair).toHaveBeenCalledWith(ORIGIN, 'key-id-1')
  })

  it('on a new-daemon success, does NOT persist a legacy secret (confirmation happens on first login)', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async () =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(load(ORIGIN)).toBeNull()
  })

  it('is non-fatal on rejection: does not throw', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'forbidden_origin' }, 403))
    expect(() => enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(load(ORIGIN)).toBeNull()
  })

  it('is non-fatal on a network failure', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(() => enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(load(ORIGIN)).toBeNull()
  })

  it('is non-fatal when keypair generation itself fails (e.g. no WebCrypto)', async () => {
    const deps = makeDeps({
      getOrCreateKeypair: vi.fn(async () => {
        throw new Error('WebCrypto unavailable')
      }),
    })
    const fetchMock = vi.fn()
    expect(() => enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)).not.toThrow()
    await vi.waitFor(() => expect(deps.getOrCreateKeypair).toHaveBeenCalled())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('single-flight: two calls before the first resolves make exactly one fetch', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async () =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('single-flight is keyed by origin: a concurrent enrollment for another origin still fetches', async () => {
    const OTHER_ORIGIN = 'http://localhost:4000'
    const deps = makeDeps()
    let resolveFirstFetch: (() => void) | undefined
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolveFirstFetch = () =>
            resolve(jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }))
        }),
    )
    const fetchMock2 = vi.fn(async () =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )

    // Origin A's enrollment starts and stays pending (fetch not yet resolved).
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    // Origin B's enrollment must not be swallowed by A's in-flight single-flight.
    enrollForReconnectOnce(OTHER_ORIGIN, 'daemon-token', fetchMock2, deps)
    await vi.waitFor(() => expect(fetchMock2).toHaveBeenCalled())

    resolveFirstFetch?.()
  })

  it('re-enrolls after a settled attempt (a later pairing in the same SPA session)', async () => {
    const deps = makeDeps()
    const fetchMock = vi.fn(async () =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock, deps)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const fetchMock2 = vi.fn(async () =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    await vi.waitFor(() => {
      enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock2, deps)
      expect(fetchMock2).toHaveBeenCalledTimes(1)
    })
  })
})
