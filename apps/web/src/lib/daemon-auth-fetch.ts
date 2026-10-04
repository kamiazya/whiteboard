/**
 * The daemon-addressed fetch, in a module of its own so a SharedWorker can
 * import it without pulling daemon-api-client.ts's response-schema graph in
 * and stalling its module load.
 */
import { isBridgeDaemon } from './bridge-address.js'
import { bridgeFetch } from './bridge-loader.js'

/**
 * The daemon a session is connected to — exactly what `createDaemonFetch`
 * consumes. One declaration rather than an inline literal per surface, so a
 * surface cannot drift from the others without a type error.
 */
export interface ConnectedDaemon {
  baseUrl: string
}

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
 * A preconstructed Request rebuilt against the resolved URL, carrying its own
 * semantics through: losing `signal` in particular would break
 * abort-on-unmount for callers that pass one. `mode` is deliberately NOT
 * copied — a Request can carry mode 'navigate', which is invalid as a fetch
 * init value and throws.
 */
function rebuiltRequestInit(
  input: Request,
  init: RequestInit | undefined,
  headers: Headers,
): RequestInit {
  const body =
    init?.body ?? (input.method === 'GET' || input.method === 'HEAD' ? undefined : input.body)
  return {
    method: input.method,
    body,
    signal: input.signal,
    credentials: input.credentials,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    integrity: input.integrity,
    keepalive: input.keepalive,
    // Fetch spec: a ReadableStream body requires `duplex: 'half'` or the call
    // throws (browsers/undici enforce this at runtime).
    ...(body ? { duplex: 'half' as const } : {}),
    ...init,
    headers,
  }
}

/**
 * Fetch wrapper for a connected daemon: resolves relative `/api/...` paths
 * against `daemonBaseUrl` and sends the request through the transport that
 * reaches it. The page holds no credential, so nothing is attached — the
 * daemon authenticates the connection (a cookie, or the extension's bridge),
 * never the request, and daemon-auth-seam.test.ts keeps it that way.
 */
export function createDaemonFetch(
  daemonBaseUrl: string,
  // The fetch this wrapper delegates to. Injectable so a caller that already
  // holds its own fetch (a test double, a same-origin page helper) can route
  // through this one resolution step.
  baseFetch: typeof globalThis.fetch = fetch,
): typeof globalThis.fetch {
  // A daemon reached through the extension has an address nothing on a network
  // answers, so the bridge is its transport whatever fetch a caller handed in
  // — several pass their own network one explicitly.
  const transport = isBridgeDaemon(daemonBaseUrl) ? bridgeFetch : baseFetch

  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const resolvedUrl = resolveRequestUrl(input, daemonBaseUrl)
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )

    if (input instanceof Request) {
      return transport(resolvedUrl, rebuiltRequestInit(input, init, headers))
    }

    return transport(resolvedUrl, { ...init, headers })
  }
}
