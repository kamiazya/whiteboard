import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDaemonPing, resolveConnectHost } from './daemon-ping-client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveConnectHost', () => {
  it('maps 0.0.0.0 to 127.0.0.1', () => {
    expect(resolveConnectHost('0.0.0.0')).toBe('127.0.0.1')
  })

  it('maps :: and ::0 to bracketed IPv6 loopback', () => {
    expect(resolveConnectHost('::')).toBe('[::1]')
    expect(resolveConnectHost('::0')).toBe('[::1]')
  })

  it('brackets a bare IPv6 address', () => {
    expect(resolveConnectHost('::1')).toBe('[::1]')
  })

  it('leaves an already-bracketed IPv6 address and plain hostnames unchanged', () => {
    expect(resolveConnectHost('[::1]')).toBe('[::1]')
    expect(resolveConnectHost('127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('fetchDaemonPing', () => {
  it('parses a valid response through daemonPingResponseSchema', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'abc-123' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchDaemonPing('127.0.0.1', 3099)

    expect(result).toEqual({ ok: true, instanceId: 'abc-123' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3099/api/runtime/ping',
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  // This is the regression the CLI's hand-cast callers used to miss: a body
  // that doesn't match the schema (e.g. instanceId renamed or dropped) must
  // fail closed instead of silently coercing to `undefined === undefined`.
  it('returns null when the response body does not match daemonPingResponseSchema', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, pid: 123 }),
    }))

    const result = await fetchDaemonPing('127.0.0.1', 3099)

    expect(result).toBeNull()
  })

  // A hand-written `typeof body?.instanceId === 'string'` cast would accept
  // this body (it has a valid-looking instanceId), but the schema correctly
  // rejects it because `ok` isn't the literal `true` the endpoint promises.
  it('returns null when ok is not the literal true, even if instanceId looks valid', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: false, instanceId: 'abc-123' }),
    }))

    const result = await fetchDaemonPing('127.0.0.1', 3099)

    expect(result).toBeNull()
  })

  it('returns null on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({}) }))

    const result = await fetchDaemonPing('127.0.0.1', 3099)

    expect(result).toBeNull()
  })

  it('returns null when fetch throws (connection refused, timeout, etc.)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })

    const result = await fetchDaemonPing('127.0.0.1', 3099)

    expect(result).toBeNull()
  })
})
