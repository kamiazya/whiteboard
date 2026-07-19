import type { EcP256PublicJwk } from '@kamiazya/whiteboard-mcp/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  enrollReconnectCredential,
  redeemReconnectSessionWithChallenge,
  redeemReconnectSessionWithLegacySecret,
  requestReconnectChallenge,
} from './reconnect-client.js'

const PUBLIC_JWK: EcP256PublicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('enrollReconnectCredential', () => {
  it('POSTs the public key JWK with Authorization: Bearer <token> when a daemon token is present', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    const result = await enrollReconnectCredential(
      'http://localhost:3099',
      'daemon-token',
      PUBLIC_JWK,
      fetchMock,
    )
    expect(result).toEqual({ status: 'ok', expiresInDays: 30 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://localhost:3099/api/reconnect-credential')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer daemon-token',
    )
    expect(JSON.parse(init?.body as string)).toEqual({ publicKeyJwk: PUBLIC_JWK })
  })

  it('omits the Authorization header entirely for a tokenless daemon', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 }),
    )
    await enrollReconnectCredential('http://localhost:3099', null, PUBLIC_JWK, fetchMock)
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it('maps a middleware 401 to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    expect(
      await enrollReconnectCredential('http://localhost:3099', 'bad', PUBLIC_JWK, fetchMock),
    ).toEqual({ status: 'rejected' })
  })

  it('maps a route 403 (inadmissible origin / invalid public key) to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'forbidden_origin' }, 403))
    expect(
      await enrollReconnectCredential('http://localhost:3099', 'token', PUBLIC_JWK, fetchMock),
    ).toEqual({ status: 'rejected' })
  })

  it('maps a thrown/rejected fetch to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(
      await enrollReconnectCredential('http://localhost:3099', 'token', PUBLIC_JWK, fetchMock),
    ).toEqual({ status: 'network-error' })
  })

  it('falls back to legacy on a pre-migration daemon response shape (no credentialKind)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    expect(
      await enrollReconnectCredential('http://localhost:3099', 'token', PUBLIC_JWK, fetchMock),
    ).toEqual({ status: 'legacy', secret: 'secret-1' })
  })

  it('maps a schema-invalid 200 body to invalid-response without throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ nope: true }))
    expect(
      await enrollReconnectCredential('http://localhost:3099', 'token', PUBLIC_JWK, fetchMock),
    ).toEqual({ status: 'invalid-response' })
  })

  it('maps malformed JSON to invalid-response without throwing', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    expect(
      await enrollReconnectCredential('http://localhost:3099', 'token', PUBLIC_JWK, fetchMock),
    ).toEqual({ status: 'invalid-response' })
  })
})

describe('requestReconnectChallenge', () => {
  it('POSTs unauthenticated to /api/reconnect-challenge and parses the nonce', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ challengeId: 'c-1', nonce: 'nonce-1', expiresInSeconds: 60 }),
    )
    const result = await requestReconnectChallenge('http://localhost:3099', fetchMock)
    expect(result).toEqual({ status: 'ok', challengeId: 'c-1', nonce: 'nonce-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://localhost:3099/api/reconnect-challenge')
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined()
  })

  it('maps a 403 (inadmissible origin) to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'forbidden_origin' }, 403))
    expect(await requestReconnectChallenge('http://localhost:3099', fetchMock)).toEqual({
      status: 'rejected',
    })
  })

  it('maps a 429 (too many pending challenges) to invalid-response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'too_many_pending_challenges' }, 429))
    expect(await requestReconnectChallenge('http://localhost:3099', fetchMock)).toEqual({
      status: 'invalid-response',
    })
  })

  it('maps a network failure to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await requestReconnectChallenge('http://localhost:3099', fetchMock)).toEqual({
      status: 'network-error',
    })
  })
})

describe('redeemReconnectSessionWithChallenge', () => {
  it('POSTs {challengeId, signature} to /api/reconnect-session and returns the token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ token: 'daemon-token' }),
    )
    const result = await redeemReconnectSessionWithChallenge(
      'http://localhost:3099',
      'challenge-1',
      'sig-1',
      fetchMock,
    )
    expect(result).toEqual({ status: 'ok', token: 'daemon-token' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://localhost:3099/api/reconnect-session')
    expect(JSON.parse(init?.body as string)).toEqual({
      challengeId: 'challenge-1',
      signature: 'sig-1',
    })
  })

  it('accepts an empty token string (tokenless dev daemon)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: '' }))
    const result = await redeemReconnectSessionWithChallenge(
      'http://localhost:3099',
      'challenge-1',
      'sig-1',
      fetchMock,
    )
    expect(result).toEqual({ status: 'ok', token: '' })
  })

  it('maps 403 (invalid signature / expired challenge) to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 403))
    expect(
      await redeemReconnectSessionWithChallenge(
        'http://localhost:3099',
        'challenge-1',
        'sig-1',
        fetchMock,
      ),
    ).toEqual({ status: 'rejected' })
  })

  it('maps a network failure to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(
      await redeemReconnectSessionWithChallenge(
        'http://localhost:3099',
        'challenge-1',
        'sig-1',
        fetchMock,
      ),
    ).toEqual({ status: 'network-error' })
  })
})

describe('redeemReconnectSessionWithLegacySecret', () => {
  it('POSTs the secret as Authorization: Bearer to /api/reconnect-session', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ token: 'daemon-token' }),
    )
    const result = await redeemReconnectSessionWithLegacySecret(
      'http://localhost:3099',
      'secret-1',
      fetchMock,
    )
    expect(result).toEqual({ status: 'ok', token: 'daemon-token' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://localhost:3099/api/reconnect-session')
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer secret-1',
    )
  })

  it('maps 403 to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 403))
    expect(
      await redeemReconnectSessionWithLegacySecret('http://localhost:3099', 'stale', fetchMock),
    ).toEqual({ status: 'rejected' })
  })

  it('maps a network failure to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(
      await redeemReconnectSessionWithLegacySecret('http://localhost:3099', 'secret-1', fetchMock),
    ).toEqual({ status: 'network-error' })
  })

  it('maps an aborted signal to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    const controller = new AbortController()
    controller.abort()
    expect(
      await redeemReconnectSessionWithLegacySecret(
        'http://localhost:3099',
        'secret-1',
        fetchMock,
        controller.signal,
      ),
    ).toEqual({ status: 'network-error' })
  })
})
