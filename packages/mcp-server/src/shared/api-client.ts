import { injectTraceContextIntoHeaders } from './browser-tracing.js'

export interface RuntimeConfig {
  daemonToken: string | null
}

// This module compiles under both tsconfig.server.json (lib ES2022 + types
// node — no DOM lib, no ambient `window`) and apps/web's DOM-enabled
// tsconfig. A structurally-typed globalThis read satisfies both without
// `declare global` (which would collide with the real DOM `Window` type)
// and without adding 'DOM' to tsconfig.server.json (which would legalize
// DOM globals across all server/cli/daemon code).
type WindowLike = {
  location: { origin: string }
  __WHITEBOARD_RUNTIME_CONFIG__?: RuntimeConfig
}

function getWindow(): WindowLike | undefined {
  return (globalThis as { window?: WindowLike }).window
}

export function readRuntimeConfig(): RuntimeConfig {
  return getWindow()?.__WHITEBOARD_RUNTIME_CONFIG__ ?? { daemonToken: null }
}

function isLocalApiRequest(input: Request | string | URL): boolean {
  const currentOrigin = getWindow()?.location.origin ?? 'http://localhost'
  const url =
    typeof input === 'string'
      ? new URL(input, currentOrigin)
      : input instanceof URL
        ? input
        : new URL(input.url, currentOrigin)
  return url.origin === currentOrigin && url.pathname.startsWith('/api/')
}

export async function apiFetch(
  input: Request | string | URL,
  init?: RequestInit,
): Promise<Response> {
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
