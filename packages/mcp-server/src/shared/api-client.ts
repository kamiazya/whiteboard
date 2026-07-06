import { z } from 'zod'
import { injectTraceContextIntoHeaders } from './browser-tracing.js'

// The server injects this shape into `window.__WHITEBOARD_RUNTIME_CONFIG__`
// via a same-origin inline <script> (see server/app.ts). It crosses a
// process boundary (server -> browser), so it is validated on read rather
// than trusted as a cast — a malformed or tampered global falls back to the
// unauthenticated default instead of propagating a bad value into apiFetch.
export const runtimeConfigSchema = z.object({
  daemonToken: z.string().nullable(),
})

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = { daemonToken: null }

// This module compiles under both tsconfig.server.json (lib ES2022 + types
// node — no DOM lib, no ambient `window`) and apps/web's DOM-enabled
// tsconfig. A structurally-typed globalThis read satisfies both without
// `declare global` (which would collide with the real DOM `Window` type)
// and without adding 'DOM' to tsconfig.server.json (which would legalize
// DOM globals across all server/cli/daemon code).
type WindowLike = {
  location: { origin: string }
  __WHITEBOARD_RUNTIME_CONFIG__?: unknown
}

function getWindow(): WindowLike | undefined {
  return (globalThis as { window?: WindowLike }).window
}

export function readRuntimeConfig(): RuntimeConfig {
  const injected = getWindow()?.__WHITEBOARD_RUNTIME_CONFIG__
  if (injected === undefined) {
    return DEFAULT_RUNTIME_CONFIG
  }
  const result = runtimeConfigSchema.safeParse(injected)
  return result.success ? result.data : DEFAULT_RUNTIME_CONFIG
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
  // Seed from the Request's own headers when no init.headers override is given —
  // fetch() replaces (not merges) a Request input's headers with the ones passed
  // in init, which would silently drop them.
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
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
