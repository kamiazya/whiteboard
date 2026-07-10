import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCanvas,
  createDaemonFetch,
  listCanvases,
  listWorkspaces,
} from './daemon-api-client.js'

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createDaemonFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves a relative string path against daemonBaseUrl', async () => {
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL)
    await daemonFetch('/api/workspaces')
    const [urlArg] = fetchMock.mock.calls[0]
    expect(String(urlArg)).toBe(`${DAEMON_BASE_URL}/api/workspaces`)
  })

  it('attaches an Authorization header when a token is configured', async () => {
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'my-token')
    await daemonFetch('/api/workspaces')
    const [, initArg] = fetchMock.mock.calls[0]
    const headers = new Headers(initArg?.headers)
    expect(headers.get('Authorization')).toBe('Bearer my-token')
  })

  it('does not attach an Authorization header when no token is configured', async () => {
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL)
    await daemonFetch('/api/workspaces')
    const [, initArg] = fetchMock.mock.calls[0]
    const headers = new Headers(initArg?.headers)
    expect(headers.get('Authorization')).toBeNull()
  })

  it('preserves method/headers/body for a Request-object input, same-origin', async () => {
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'my-token')
    const req = new Request(`${DAEMON_BASE_URL}/api/canvases`, {
      method: 'POST',
      headers: { 'X-Custom': 'yes' },
      body: JSON.stringify({ a: 1 }),
    })
    await daemonFetch(req)
    const [, initArg] = fetchMock.mock.calls[0]
    expect(initArg?.method).toBe('POST')
    const headers = new Headers(initArg?.headers)
    expect(headers.get('X-Custom')).toBe('yes')
    expect(headers.get('Authorization')).toBe('Bearer my-token')
  })

  it('preserves the abort signal (and request semantics) from a Request-object input', async () => {
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'my-token')
    const controller = new AbortController()
    const req = new Request(`${DAEMON_BASE_URL}/api/canvases`, {
      method: 'GET',
      signal: controller.signal,
      keepalive: true,
    })
    await daemonFetch(req)
    const [, initArg] = fetchMock.mock.calls[0]
    // Losing `signal` would break abort-on-unmount for callers passing a
    // preconstructed Request through this wrapper.
    expect(initArg?.signal).toBe(req.signal)
    expect(initArg?.keepalive).toBe(true)
    expect(initArg?.credentials).toBe(req.credentials)
  })

  it('sets duplex: "half" when forwarding a Request whose body is a stream', async () => {
    // Fetch spec: passing a ReadableStream as `body` requires `duplex: 'half'`
    // in RequestInit, or the call throws in browsers/undici that enforce it.
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'my-token')
    const req = new Request(`${DAEMON_BASE_URL}/api/canvases`, {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    })
    await daemonFetch(req)
    const [, initArg] = fetchMock.mock.calls[0]
    expect(initArg?.body).toBeTruthy()
    expect(initArg?.duplex).toBe('half')
  })

  it('never attaches the daemon token to an absolute external URL', async () => {
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'my-token')
    await daemonFetch('https://evil.example/x')
    const [urlArg, initArg] = fetchMock.mock.calls[0]
    expect(String(urlArg)).toBe('https://evil.example/x')
    const headers = new Headers(initArg?.headers)
    expect(headers.get('Authorization')).toBeNull()
  })

  it('never attaches the daemon token to a foreign-origin Request object', async () => {
    const daemonFetch = createDaemonFetch(DAEMON_BASE_URL, 'my-token')
    const req = new Request('https://evil.example/x', { method: 'GET' })
    await daemonFetch(req)
    const [, initArg] = fetchMock.mock.calls[0]
    const headers = new Headers(initArg?.headers)
    expect(headers.get('Authorization')).toBeNull()
  })
})

describe('listWorkspaces', () => {
  it('parses a valid response body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ workspaces: [{ workspaceId: 'w1' }] }))
    const result = await listWorkspaces(fetchFn, DAEMON_BASE_URL)
    expect(result).toEqual({ workspaces: [{ workspaceId: 'w1' }] })
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ workspaces: [{ nope: true }] }))
    await expect(listWorkspaces(fetchFn, DAEMON_BASE_URL)).rejects.toThrow(/validation/i)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Not found' }, 404))
    await expect(listWorkspaces(fetchFn, DAEMON_BASE_URL)).rejects.toThrow(/not found/i)
  })
})

describe('listCanvases', () => {
  it('parses a valid response body', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ canvases: [{ slug: 'main', updatedAt: '2026-01-01' }] }))
    const result = await listCanvases(fetchFn, DAEMON_BASE_URL, 'w1')
    expect(result).toEqual({ canvases: [{ slug: 'main', updatedAt: '2026-01-01' }] })
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ canvases: [{ slug: 1 }] }))
    await expect(listCanvases(fetchFn, DAEMON_BASE_URL, 'w1')).rejects.toThrow(/validation/i)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Server error' }, 500))
    await expect(listCanvases(fetchFn, DAEMON_BASE_URL, 'w1')).rejects.toThrow(/server error/i)
  })
})

describe('createCanvas', () => {
  it('parses a valid response body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ slug: 'new-canvas' }))
    const result = await createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'new-canvas')
    expect(result).toEqual({ slug: 'new-canvas' })
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ nope: true }))
    await expect(createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'x')).rejects.toThrow(/validation/i)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Conflict' }, 409))
    await expect(createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'x')).rejects.toThrow(/conflict/i)
  })
})
