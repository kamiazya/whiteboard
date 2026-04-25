export interface DaemonClient {
  port: number
  baseUrl: string
  request: (path: string, init?: RequestInit) => Promise<Response>
  touch: () => Promise<void>
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString()
}

function withBearerToken(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
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
