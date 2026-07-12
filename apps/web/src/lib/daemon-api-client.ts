import {
  type CreateCanvasResponse,
  createCanvasResponseSchema,
  type ListCanvasesResponse,
  listCanvasesResponseSchema,
  type ListWorkspacesResponse,
  listWorkspacesResponseSchema,
  problemDetailsErrorSchema,
  type UpdateCanvasResponse,
  updateCanvasResponseSchema,
  type WorkspaceNames,
  workspaceNamesSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'

/**
 * Resolves an input (string/URL/Request) against `daemonBaseUrl` and returns
 * its final URL object. Relative string/URL inputs resolve against
 * daemonBaseUrl; absolute inputs and Request objects keep their own origin
 * untouched (mirrors how `fetch()` itself treats a Request's url).
 */
function resolveRequestUrl(input: Request | string | URL, daemonBaseUrl: string): URL {
  if (input instanceof Request) {
    return new URL(input.url)
  }
  return new URL(input, daemonBaseUrl)
}

/**
 * Cross-origin fetch wrapper for a paired daemon. Resolves relative
 * `/api/...` paths against `daemonBaseUrl` and attaches an `Authorization:
 * Bearer` header — but ONLY when the fully-resolved request URL's origin
 * equals the daemon's own origin. This mirrors apiFetch's same-origin-only
 * rule (packages/mcp-server/src/shared/api-client.ts): the daemon bearer
 * token must never leak to an absolute external URL or a foreign-origin
 * Request object that happens to pass through this wrapper (e.g. an
 * Excalidraw asset fetch).
 */
export function createDaemonFetch(daemonBaseUrl: string, token?: string): typeof globalThis.fetch {
  const daemonOrigin = new URL(daemonBaseUrl).origin

  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const resolvedUrl = resolveRequestUrl(input, daemonBaseUrl)
    const isDaemonOrigin = resolvedUrl.origin === daemonOrigin

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (token && isDaemonOrigin) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    if (input instanceof Request) {
      const body =
        init?.body ?? (input.method === 'GET' || input.method === 'HEAD' ? undefined : input.body)
      return fetch(resolvedUrl, {
        method: input.method,
        body,
        // Carry the Request's own semantics through the rebuild — losing
        // `signal` in particular would break abort-on-unmount for callers
        // that pass a preconstructed Request. `mode` is deliberately NOT
        // copied: a Request can carry mode 'navigate', which is invalid as a
        // fetch init value and throws.
        signal: input.signal,
        credentials: input.credentials,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        integrity: input.integrity,
        keepalive: input.keepalive,
        // Fetch spec: a ReadableStream body requires `duplex: 'half'` or the
        // call throws (browsers/undici enforce this at runtime).
        ...(body ? { duplex: 'half' as const } : {}),
        ...init,
        headers,
      })
    }

    return fetch(resolvedUrl, { ...init, headers })
  }
}

async function parseProblemDetails(res: Response): Promise<string> {
  try {
    const json = await res.json()
    const parsed = problemDetailsErrorSchema.safeParse(json)
    if (parsed.success && parsed.data.title) return parsed.data.title
  } catch {
    // fall through to the generic message below
  }
  return `Request failed (${res.status}).`
}

async function fetchAndParse<T>(
  fetchFn: typeof globalThis.fetch,
  url: string,
  schema: { parse: (input: unknown) => T },
  init?: RequestInit,
): Promise<T> {
  const res = await fetchFn(url, init)
  if (!res.ok) {
    throw new Error(await parseProblemDetails(res))
  }
  const json = await res.json()
  try {
    return schema.parse(json)
  } catch {
    throw new Error('Response failed schema validation.')
  }
}

export function listWorkspaces(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
): Promise<ListWorkspacesResponse> {
  return fetchAndParse(fetchFn, `${daemonBaseUrl}/api/workspaces`, listWorkspacesResponseSchema)
}

export function listCanvases(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<ListCanvasesResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
    listCanvasesResponseSchema,
  )
}

export function createCanvas(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
): Promise<CreateCanvasResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
    createCanvasResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    },
  )
}

// GET /api/canvas/:workspaceId/:slug/snapshot returns raw Loro bytes
// (application/octet-stream), not JSON — kept separate from fetchAndParse,
// which always calls res.json().
export async function getCanvasSnapshot(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
): Promise<Uint8Array> {
  const url = `${daemonBaseUrl}/api/canvas/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}/snapshot`
  const res = await fetchFn(url)
  if (!res.ok) {
    throw new Error(await parseProblemDetails(res))
  }
  return new Uint8Array(await res.arrayBuffer())
}

export function updateCanvas(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
  snapshot: Uint8Array,
): Promise<UpdateCanvasResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/canvas/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}/update`,
    updateCanvasResponseSchema,
    { method: 'POST', body: snapshot as BodyInit },
  )
}

export function setCanvasName(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
  name: string,
): Promise<WorkspaceNames> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/canvases/${encodeURIComponent(slug)}/name`,
    workspaceNamesSchema,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  )
}
