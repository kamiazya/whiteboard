import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import { fetchDaemonPing, resolveConnectHost, verifyDaemonIdentity } from './daemon-ping-client.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

  // Long enough for a loaded daemon to answer, short enough that a status or
  // stop against a hung one reports rather than hangs the operator's shell.
  it('gives the daemon two seconds to answer unless told otherwise', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({}) }))

    await fetchDaemonPing('127.0.0.1', 3099)
    await fetchDaemonPing('127.0.0.1', 3099, 50)

    expect(timeout.mock.calls).toEqual([[2000], [50]])
  })

  it('returns null when fetch throws (connection refused, timeout, etc.)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })

    const result = await fetchDaemonPing('127.0.0.1', 3099)

    expect(result).toBeNull()
  })
})

// The identity check that decides whether server-stop may kill the recorded
// pid and whether server-status / server-doctor call a server healthy. Their
// own tests inject an override, so the real ping + instanceId comparison is
// pinned here.
describe('verifyDaemonIdentity', () => {
  const RECORD: ServerModeRecord = {
    schemaVersion: 1,
    pid: 42,
    host: '0.0.0.0',
    port: 3099,
    publicBaseUrl: 'https://whiteboard.example.com',
    authStrategy: 'oauth-jwt',
    startedAt: '2026-05-19T00:00:00.000Z',
    instanceId: 'valid-instance-id',
  }

  it('confirms identity when the ping response instanceId matches the record', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'valid-instance-id' }),
    }))
    await expect(verifyDaemonIdentity(RECORD)).resolves.toBe(true)
  })

  it('refuses to confirm identity when the ping response instanceId mismatches', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, instanceId: 'some-other-instance-id' }),
    }))
    await expect(verifyDaemonIdentity(RECORD)).resolves.toBe(false)
  })

  it('never confirms identity when the record predates instanceId', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(verifyDaemonIdentity({ ...RECORD, instanceId: undefined })).resolves.toBe(false)
    // Short-circuits before making a network call.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
