/**
 * The daemon's Authorization seam, deliberately in a module of its own.
 *
 * It used to sit in daemon-api-client.ts beside that file's response schemas,
 * which made the seam a whole module rather than a function: a SharedWorker
 * importing it pulled the schema graph in and stalled its module load, leaving
 * the worker unable to attach the credential without duplicating the header —
 * exactly what daemon-auth-seam.test.ts forbids. Keeping it small lets every
 * context share the one implementation.
 */
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
 *
 * This is the SOLE place in apps/web allowed to set an Authorization header
 * toward the daemon (enforced by daemon-auth-seam.test.ts's source scan).
 * Keeping the token's attachment in one seam, rather than at each call site,
 * is what lets a browser-extension proxy replace this single function instead
 * of requiring an audit of every fetch in the app. That matters because an
 * extension is the only place a persisted daemon credential can live safely:
 * extension storage is scoped to the extension ID, not to a web origin that
 * another process can take over by claiming the port.
 */
export function createDaemonFetch(
  daemonBaseUrl: string,
  token?: string,
  // The fetch this wrapper delegates to. Injectable so a caller that already
  // holds its own fetch (a test double, a same-origin page helper) can route
  // its credential through this one seam instead of setting the header itself.
  baseFetch: typeof globalThis.fetch = fetch,
): typeof globalThis.fetch {
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
      return baseFetch(resolvedUrl, {
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

    return baseFetch(resolvedUrl, { ...init, headers })
  }
}
