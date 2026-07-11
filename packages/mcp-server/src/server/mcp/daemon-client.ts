import { injectContextIntoHeaders } from '../observability/tracing.js'

export interface DaemonClient {
  port: number
  baseUrl: string
  token: string
  request: (path: string, init?: RequestInit) => Promise<Response>
  touch: () => Promise<void>
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString()
}

function withBearerToken(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  // Forward the active OpenTelemetry context as W3C `traceparent` so the
  // daemon's HTTP middleware can stitch the inbound request span onto the
  // current MCP tool span. No-op when tracing is disabled (the OTel API
  // returns a no-op context with an invalid trace ID, which propagation
  // skips).
  const carrier: Record<string, string> = {}
  injectContextIntoHeaders(carrier)
  for (const [k, v] of Object.entries(carrier)) headers.set(k, v)
  return {
    ...init,
    headers,
  }
}

export function daemonUrl(client: Pick<DaemonClient, 'baseUrl'>, path: string): string {
  return buildUrl(client.baseUrl, path)
}

export function createDaemonClient(input: {
  port: number
  baseUrl: string
  token: string
}): DaemonClient {
  return {
    port: input.port,
    baseUrl: input.baseUrl,
    token: input.token,
    request(path, init) {
      return fetch(buildUrl(input.baseUrl, path), withBearerToken(init, input.token))
    },
    async touch() {
      const res = await this.request('/api/runtime/touch', { method: 'POST' })
      if (!res.ok) {
        throw new Error(`Failed to touch daemon: ${res.status}`)
      }
    },
  }
}
