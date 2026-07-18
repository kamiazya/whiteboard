import { z } from 'zod'
import { injectTraceContextIntoHeaders } from './browser-tracing.js'
import { readDaemonTokenOnce } from './token-store.js'

// Re-exported so daemon-pairing callers (apps/web's useDaemonConnection) can
// seed/verify the same module-singleton token store this file reads from,
// without a separate package export just for pairing/test access.
export { readDaemonTokenOnce, resetTokenStoreForTests, seedDaemonToken } from './token-store.js'

// The server injects this shape into `window.__WHITEBOARD_RUNTIME_CONFIG__`
// via a same-origin inline <script> (see server/app.ts). It crosses a
// process boundary (server -> browser), so it is validated on read rather
// than trusted as a cast — a malformed or tampered global falls back to the
// unauthenticated default instead of propagating a bad value into apiFetch.
//
// Permanently token-free (ADR-0002 addendum): the daemon auth token travels
// through its own global (see token-store.ts) so it never lands in a config
// object that logging / error-reporting could serialize wholesale. `.strict()`
// means a payload that still carries `daemonToken` fails validation rather
// than silently dropping the extra key, so a stale server build cannot slip
// a token back into this object undetected.
export const runtimeConfigSchema = z
  .object({
    daemonBaseUrl: z.string().optional(),
  })
  .strict()

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {}

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
  const daemonToken = readDaemonTokenOnce()
  if (daemonToken) {
    headers.set('Authorization', `Bearer ${daemonToken}`)
  }
  return fetch(input, {
    ...init,
    headers,
  })
}
