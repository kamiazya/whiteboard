// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDaemonFetch,
  createDocument,
  createWorkspace,
  deleteDocument,
  getDocumentSnapshot,
  listDocuments,
  listWorkspaces,
  renameDocumentPath,
  renameWorkspace,
  setDocumentDisplayName,
  updateDocument,
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
    const req = new Request(`${DAEMON_BASE_URL}/api/documents`, {
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
    const req = new Request(`${DAEMON_BASE_URL}/api/documents`, {
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
    const req = new Request(`${DAEMON_BASE_URL}/api/documents`, {
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

describe('listDocuments', () => {
  it('parses a valid response body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
      }),
    )
    const result = await listDocuments(fetchFn, DAEMON_BASE_URL, 'w1')
    expect(result).toEqual({
      documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })

  it('rejects a summary the daemon serves without id or kind — every row records both', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ documents: [{ path: 'main', updatedAt: '2026-01-01' }] }))
    await expect(listDocuments(fetchFn, DAEMON_BASE_URL, 'w1')).rejects.toThrow(/validation/i)
  })

  it('preserves a recorded kind', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        documents: [{ path: 'note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
      }),
    )
    const result = await listDocuments(fetchFn, DAEMON_BASE_URL, 'w1')
    expect(result.documents[0]?.kind).toBe('markdown')
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ documents: [{ path: 1 }] }))
    await expect(listDocuments(fetchFn, DAEMON_BASE_URL, 'w1')).rejects.toThrow(/validation/i)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Server error' }, 500))
    await expect(listDocuments(fetchFn, DAEMON_BASE_URL, 'w1')).rejects.toThrow(/server error/i)
  })
})

describe('createDocument', () => {
  it('parses a valid response body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ path: 'new-canvas' }))
    const result = await createDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'new-canvas')
    expect(result).toEqual({ path: 'new-canvas' })
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ nope: true }))
    await expect(createDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'x')).rejects.toThrow(/validation/i)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Conflict' }, 409))
    await expect(createDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'x')).rejects.toThrow(/conflict/i)
  })

  it('sends kind in the POST body when given, omits it otherwise', async () => {
    const sentBody = (fetchFn: ReturnType<typeof vi.fn>) => {
      const init = fetchFn.mock.calls[0]![1] as RequestInit
      return JSON.parse(init.body as string)
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ path: 'x' }))
    await createDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'x', 'markdown')
    expect(sentBody(fetchFn)).toEqual({ path: 'x', kind: 'markdown' })
    fetchFn.mockClear()
    fetchFn.mockResolvedValue(jsonResponse({ path: 'y' }))
    await createDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'y')
    expect(sentBody(fetchFn)).toEqual({ path: 'y' })
  })
})

describe('deleteDocument', () => {
  it('sends DELETE to the canvas URL and parses the ok body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    const result = await deleteDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'old-canvas')
    expect(result).toEqual({ ok: true })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(String(url)).toBe(`${DAEMON_BASE_URL}/api/workspaces/w1/documents/old-canvas`)
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('rejects on a 404, surfacing the problem-details title', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Canvas not found' }, 404))
    await expect(deleteDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'gone')).rejects.toThrow(
      /canvas not found/i,
    )
  })
})

describe('getDocumentSnapshot', () => {
  it('returns the raw octet-stream body as a Uint8Array', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
    const result = await getDocumentSnapshot(fetchFn, DAEMON_BASE_URL, 'w1', 'main')
    expect(new Uint8Array(result)).toEqual(bytes)
    expect(fetchFn).toHaveBeenCalledWith(`${DAEMON_BASE_URL}/api/w/w1/document/main/snapshot`)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Not found' }, 404))
    await expect(getDocumentSnapshot(fetchFn, DAEMON_BASE_URL, 'w1', 'main')).rejects.toThrow(
      /not found/i,
    )
  })
})

describe('updateDocument', () => {
  it('POSTs the snapshot bytes as the request body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    const bytes = new Uint8Array([9, 9, 9])
    const result = await updateDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'main', bytes)
    expect(result).toEqual({ ok: true })
    const [urlArg, initArg] = fetchFn.mock.calls[0]
    expect(String(urlArg)).toBe(`${DAEMON_BASE_URL}/api/w/w1/document/main/update`)
    expect(initArg?.method).toBe('POST')
    expect(initArg?.body).toBe(bytes)
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Server error' }, 500))
    await expect(
      updateDocument(fetchFn, DAEMON_BASE_URL, 'w1', 'main', new Uint8Array()),
    ).rejects.toThrow(/server error/i)
  })
})

describe('setDocumentDisplayName', () => {
  it('PUTs the name and parses the returned WorkspaceNames payload', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ documents: { main: 'My canvas' }, pinned: [] }))
    const result = await setDocumentDisplayName(fetchFn, DAEMON_BASE_URL, 'w1', 'main', 'My canvas')
    expect(result).toEqual({ documents: { main: 'My canvas' }, pinned: [] })
    const [urlArg, initArg] = fetchFn.mock.calls[0]
    expect(String(urlArg)).toBe(`${DAEMON_BASE_URL}/api/workspaces/w1/documents/main/name`)
    expect(initArg?.method).toBe('PUT')
    expect(JSON.parse(String(initArg?.body))).toEqual({ name: 'My canvas' })
  })

  it('rejects on a non-2xx response, surfacing problem+json detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Bad request' }, 400))
    await expect(
      setDocumentDisplayName(fetchFn, DAEMON_BASE_URL, 'w1', 'main', 'x'),
    ).rejects.toThrow(/bad request/i)
  })
})

describe('renameDocumentPath', () => {
  it('sends the new path to the old path’s /path URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ path: 'archive/notes' }))
    const result = await renameDocumentPath(
      fetchFn,
      DAEMON_BASE_URL,
      'w1',
      'design/notes',
      'archive/notes',
    )

    expect(result).toEqual({ path: 'archive/notes' })
    const [url, init] = fetchFn.mock.calls[0]!
    // The path being MOVED is in the URL and the destination is in the body:
    // sending the new one in the URL would address a document that does not
    // exist yet and 404.
    expect(String(url)).toBe(`${DAEMON_BASE_URL}/api/workspaces/w1/documents/design/notes/path`)
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ path: 'archive/notes' })
  })

  // The server names the PRODUCED path that collided, which for a subtree
  // move is often not the path the caller asked for. Rebuilding a message
  // here would send someone to retry the one thing that was never the
  // problem, so the status and the server's own words have to survive.
  it('carries the server’s conflict message through, with its status', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ title: 'Path "archive/notes/a" already exists' }, 409))

    await expect(
      renameDocumentPath(fetchFn, DAEMON_BASE_URL, 'w1', 'design/notes', 'archive/notes'),
    ).rejects.toMatchObject({ status: 409, message: 'Path "archive/notes/a" already exists' })
  })
})

describe('createWorkspace', () => {
  it('POSTs the display name and nothing else, and parses what came back', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ workspaceId: 'w1', segment: 'marketing', displayName: 'Marketing' }, 201),
      )
    const result = await createWorkspace(fetchFn, DAEMON_BASE_URL, 'Marketing')

    expect(result).toEqual({ workspaceId: 'w1', segment: 'marketing', displayName: 'Marketing' })
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${DAEMON_BASE_URL}/api/workspaces`)
    expect(init.method).toBe('POST')
    // The other two of ADR-0019's layers are the server's to decide. Sending
    // either would be this client claiming an identity it does not own.
    expect(JSON.parse(String(init.body))).toEqual({ displayName: 'Marketing' })
  })

  it('rejects a malformed response body without returning raw JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ nope: true }, 201))
    await expect(createWorkspace(fetchFn, DAEMON_BASE_URL, 'X')).rejects.toThrow(/validation/i)
  })

  it('surfaces the daemon reason for a refused segment', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ title: 'Segment "taken" is already in use' }, 409))
    await expect(createWorkspace(fetchFn, DAEMON_BASE_URL, 'Taken')).rejects.toThrow(
      /already in use/i,
    )
  })
})

describe('renameWorkspace', () => {
  it('PATCHes only the layers it was given, so an omitted one stays untouched', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ workspaceId: 'w1', segment: 'kept', displayName: 'New' }))
    const result = await renameWorkspace(fetchFn, DAEMON_BASE_URL, 'w1', { displayName: 'New' })

    expect(result.segment).toBe('kept')
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${DAEMON_BASE_URL}/api/workspaces/w1`)
    expect(init.method).toBe('PATCH')
    // Absent, not null: the port reads an absent field as "leave this layer
    // alone", and a null would be a different request entirely.
    expect(JSON.parse(String(init.body))).toEqual({ displayName: 'New' })
  })

  it('addresses the workspace by whatever handle it was given', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ workspaceId: 'w1', segment: 'by-segment' }))
    await renameWorkspace(fetchFn, DAEMON_BASE_URL, 'by segment', { segment: 'moved' })
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${DAEMON_BASE_URL}/api/workspaces/by%20segment`)
  })

  it('surfaces the daemon reason for a refused rename', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ title: 'Segment "taken" is already in use' }, 409))
    await expect(
      renameWorkspace(fetchFn, DAEMON_BASE_URL, 'w1', { segment: 'taken' }),
    ).rejects.toThrow(/already in use/i)
  })
})
