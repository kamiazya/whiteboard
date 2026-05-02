import { injectTraceContextIntoHeaders } from './browser-tracing.js'

interface RuntimeConfig {
  daemonToken: string | null
}

declare global {
  interface Window {
    __WHITEBOARD_RUNTIME_CONFIG__?: RuntimeConfig
  }
}

function readRuntimeConfig(): RuntimeConfig {
  if (typeof window === 'undefined') {
    return { daemonToken: null }
  }
  return window.__WHITEBOARD_RUNTIME_CONFIG__ ?? { daemonToken: null }
}

function isLocalApiRequest(input: RequestInfo | URL): boolean {
  const currentOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  const url =
    typeof input === 'string'
      ? new URL(input, currentOrigin)
      : input instanceof URL
        ? input
        : new URL(input.url, currentOrigin)
  return url.origin === currentOrigin && url.pathname.startsWith('/api/')
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isLocalApiRequest(input)) {
    return fetch(input, init)
  }
  const headers = new Headers(init?.headers)
  // Always inject the active trace context so the server middleware can
  // stitch the inbound request span onto whatever client-side span (if
  // any) is active. No-op when browser tracing has not been enabled.
  injectTraceContextIntoHeaders(headers)
  const { daemonToken } = readRuntimeConfig()
  if (daemonToken) {
    headers.set('Authorization', `Bearer ${daemonToken}`)
  }
  return fetch(input, {
    ...init,
    headers,
  })
}
