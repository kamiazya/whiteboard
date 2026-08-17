import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCanvas,
  createDaemonFetch,
  deleteCanvas,
  getCanvasSnapshot,
  listCanvases,
  listWorkspaces,
  setCanvasName,
  updateCanvas,
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
      .mockResolvedValue(jsonResponse({ canvases: [{ path: 'main', updatedAt: '2026-01-01' }] }))
    const result = await listCanvases(fetchFn, DAEMON_BASE_URL, 'w1')
    // kind is absent from the mocked daemon response (pre-change shape) and
    // defaults to 'spatial' — the back-compat rule that lets a new client
    // parse an old daemon's kind-less list.
    expect(result).toEqual({
      canvases: [{ path: 'main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ canvases: [{ path: 1 }] }))
    await expect(listCanvases(fetchFn, DAEMON_BASE_URL, 'w1')).rejects.toThrow(/validation/i)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Server error' }, 500))
    await expect(listCanvases(fetchFn, DAEMON_BASE_URL, 'w1')).rejects.toThrow(/server error/i)
  })
})

describe('createCanvas', () => {
  it('parses a valid response body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ path: 'new-canvas' }))
    const result = await createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'new-canvas')
    expect(result).toEqual({ path: 'new-canvas' })
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ nope: true }))
    await expect(createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'x')).rejects.toThrow(/validation/i)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Conflict' }, 409))
    await expect(createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'x')).rejects.toThrow(/conflict/i)
  })

  it('sends kind in the POST body when given, omits it otherwise', async () => {
    const sentBody = (fetchFn: ReturnType<typeof vi.fn>) => {
      const init = fetchFn.mock.calls[0]![1] as RequestInit
      return JSON.parse(init.body as string)
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ path: 'x' }))
    await createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'x', 'markdown')
    expect(sentBody(fetchFn)).toEqual({ path: 'x', kind: 'markdown' })
    fetchFn.mockClear()
    fetchFn.mockResolvedValue(jsonResponse({ path: 'y' }))
    await createCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'y')
    expect(sentBody(fetchFn)).toEqual({ path: 'y' })
  })
})

describe('deleteCanvas', () => {
  it('sends DELETE to the canvas URL and parses the ok body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    const result = await deleteCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'old-canvas')
    expect(result).toEqual({ ok: true })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(String(url)).toBe(`${DAEMON_BASE_URL}/api/workspaces/w1/canvases/old-canvas`)
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('rejects on a 404, surfacing the problem-details title', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Canvas not found' }, 404))
    await expect(deleteCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'gone')).rejects.toThrow(
      /canvas not found/i,
    )
  })
})

describe('getCanvasSnapshot', () => {
  it('returns the raw octet-stream body as a Uint8Array', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
    const result = await getCanvasSnapshot(fetchFn, DAEMON_BASE_URL, 'w1', 'main')
    expect(new Uint8Array(result)).toEqual(bytes)
    expect(fetchFn).toHaveBeenCalledWith(`${DAEMON_BASE_URL}/api/w/w1/canvas/main/snapshot`)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Not found' }, 404))
    await expect(getCanvasSnapshot(fetchFn, DAEMON_BASE_URL, 'w1', 'main')).rejects.toThrow(
      /not found/i,
    )
  })
})

describe('updateCanvas', () => {
  it('POSTs the snapshot bytes as the request body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    const bytes = new Uint8Array([9, 9, 9])
    const result = await updateCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'main', bytes)
    expect(result).toEqual({ ok: true })
    const [urlArg, initArg] = fetchFn.mock.calls[0]
    expect(String(urlArg)).toBe(`${DAEMON_BASE_URL}/api/w/w1/canvas/main/update`)
    expect(initArg?.method).toBe('POST')
    expect(initArg?.body).toBe(bytes)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Server error' }, 500))
    await expect(
      updateCanvas(fetchFn, DAEMON_BASE_URL, 'w1', 'main', new Uint8Array()),
    ).rejects.toThrow(/server error/i)
  })
})

describe('setCanvasName', () => {
  it('PUTs the name and parses the returned WorkspaceNames payload', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ canvases: { main: 'My canvas' }, pinned: [] }))
    const result = await setCanvasName(fetchFn, DAEMON_BASE_URL, 'w1', 'main', 'My canvas')
    expect(result).toEqual({ canvases: { main: 'My canvas' }, pinned: [] })
    const [urlArg, initArg] = fetchFn.mock.calls[0]
    expect(String(urlArg)).toBe(`${DAEMON_BASE_URL}/api/workspaces/w1/canvases/main/name`)
    expect(initArg?.method).toBe('PUT')
    expect(JSON.parse(String(initArg?.body))).toEqual({ name: 'My canvas' })
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Bad request' }, 400))
    await expect(setCanvasName(fetchFn, DAEMON_BASE_URL, 'w1', 'main', 'x')).rejects.toThrow(
      /bad request/i,
    )
  })
})
