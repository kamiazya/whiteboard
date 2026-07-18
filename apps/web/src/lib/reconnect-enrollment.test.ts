import { afterEach, describe, expect, it, vi } from 'vitest'
import { enrollForReconnectOnce, resetReconnectEnrollmentForTests } from './reconnect-enrollment.js'
import { clear as clearSecretStore, load } from './reconnect-credential-store.js'

const ORIGIN = 'http://localhost:3099'

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
  it('persists the returned secret on success', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock)
    await vi.waitFor(() => expect(load(ORIGIN)).toBe('secret-1'))
  })

  it('enrolls a tokenless daemon (authMode "none") by omitting the Authorization header', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, null, fetchMock)
    await vi.waitFor(() => expect(load(ORIGIN)).toBe('secret-1'))
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it('is non-fatal on rejection: does not persist a secret and does not throw', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'forbidden_origin' }, 403))
    expect(() => enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock)).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(load(ORIGIN)).toBeNull()
  })

  it('is non-fatal on a network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(() => enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock)).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(load(ORIGIN)).toBeNull()
  })

  it('single-flight: two calls before the first resolves make exactly one fetch', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ reconnectSecret: 'secret-1', expiresInDays: 30 }),
    )
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock)
    enrollForReconnectOnce(ORIGIN, 'daemon-token', fetchMock)
    await vi.waitFor(() => expect(load(ORIGIN)).toBe('secret-1'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
