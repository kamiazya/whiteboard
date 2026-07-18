import { describe, expect, it, vi } from 'vitest'
import { enrollReconnectCredential, redeemReconnectSession } from './reconnect-client.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('enrollReconnectCredential', () => {
  it('POSTs with Authorization: Bearer <token> when a daemon token is present', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    const result = await enrollReconnectCredential(
      'http://localhost:3099',
      'daemon-token',
      fetchMock,
    )
    expect(result).toEqual({ status: 'ok', secret: 'secret-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://localhost:3099/api/reconnect-credential')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer daemon-token',
    )
  })

  it('omits the Authorization header entirely for a tokenless daemon', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    await enrollReconnectCredential('http://localhost:3099', null, fetchMock)
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it('maps a middleware 401 to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    expect(await enrollReconnectCredential('http://localhost:3099', 'bad', fetchMock)).toEqual({
      status: 'rejected',
    })
  })

  it('maps a route 403 (inadmissible origin) to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'forbidden_origin' }, 403))
    expect(await enrollReconnectCredential('http://localhost:3099', 'token', fetchMock)).toEqual({
      status: 'rejected',
    })
  })

  it('maps a thrown/rejected fetch to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await enrollReconnectCredential('http://localhost:3099', 'token', fetchMock)).toEqual({
      status: 'network-error',
    })
  })

  it('maps a schema-invalid 200 body to invalid-response without throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ nope: true }))
    expect(await enrollReconnectCredential('http://localhost:3099', 'token', fetchMock)).toEqual({
      status: 'invalid-response',
    })
  })

  it('maps malformed JSON to invalid-response without throwing', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    expect(await enrollReconnectCredential('http://localhost:3099', 'token', fetchMock)).toEqual({
      status: 'invalid-response',
    })
  })
})

describe('redeemReconnectSession', () => {
  it('POSTs the secret as Authorization: Bearer to /api/reconnect-session', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ token: 'daemon-token', reconnectSecret: 'secret-2', expiresInDays: 30 }),
    )
    const result = await redeemReconnectSession('http://localhost:3099', 'secret-1', fetchMock)
    expect(result).toEqual({ status: 'ok', token: 'daemon-token', secret: 'secret-2' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://localhost:3099/api/reconnect-session')
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer secret-1',
    )
  })

  it('accepts an empty token string (tokenless dev daemon)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ token: '', reconnectSecret: 'secret-2', expiresInDays: 30 }),
    )
    const result = await redeemReconnectSession('http://localhost:3099', 'secret-1', fetchMock)
    expect(result).toEqual({ status: 'ok', token: '', secret: 'secret-2' })
  })

  it('maps 403 to rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 403))
    expect(await redeemReconnectSession('http://localhost:3099', 'stale', fetchMock)).toEqual({
      status: 'rejected',
    })
  })

  it('maps a network failure to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await redeemReconnectSession('http://localhost:3099', 'secret-1', fetchMock)).toEqual({
      status: 'network-error',
    })
  })

  it('maps an aborted signal to network-error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    const controller = new AbortController()
    controller.abort()
    expect(
      await redeemReconnectSession(
        'http://localhost:3099',
        'secret-1',
        fetchMock,
        controller.signal,
      ),
    ).toEqual({ status: 'network-error' })
  })
})
