import { z } from 'zod'

// The daemon auth token crosses the server -> browser boundary once, via its
// own global (window.__WHITEBOARD_DAEMON_TOKEN__), separate from
// __WHITEBOARD_RUNTIME_CONFIG__. Keeping it off the runtime-config object
// shrinks the surface that gets serialized wholesale by logging / error
// reporting — this is a serialization-surface reduction, not a security
// boundary: any script that runs before this module reads the global still
// sees it in plaintext.
//
// Module-singleton in-memory store, never persisted. First read consumes the
// global (deletes it so later code paths cannot find a second copy lying
// around) and caches the result for the rest of the session.
const tokenValueSchema = z.string()

type WindowLike = {
  __WHITEBOARD_DAEMON_TOKEN__?: unknown
}

function getWindow(): WindowLike | undefined {
  return (globalThis as { window?: WindowLike }).window
}

let cachedToken: string | null = null
let hasRead = false

export function readDaemonTokenOnce(): string | null {
  if (hasRead) {
    return cachedToken
  }
  hasRead = true
  const win = getWindow()
  if (win === undefined) {
    return null
  }
  const raw = win.__WHITEBOARD_DAEMON_TOKEN__
  try {
    delete win.__WHITEBOARD_DAEMON_TOKEN__
  } catch {
    // In strict mode, delete on a non-configurable property throws a
    // TypeError (e.g. the global was declared rather than assigned).
    // Failing to scrub is acceptable — the value is already cached, and the
    // delete is surface reduction, not a security boundary.
  }
  const result = tokenValueSchema.safeParse(raw)
  cachedToken = result.success ? result.data : null
  return cachedToken
}

// Installs a token obtained OUTSIDE the fragment global (the silent-reconnect
// flow's /api/reconnect-session redemption) into the same module-singleton
// cache that readDaemonTokenOnce() serves, so both createDaemonFetch (HTTP)
// and DaemonBackend.openSocket (WebSocket, which reads this store directly
// rather than taking a token prop) authenticate with one shared token.
//
// A no-op only when a REAL fragment token has already been consumed (guarded
// on `cachedToken`, not `hasRead`): the fragment path — an explicit #wb=
// pairing link — takes precedence over a reconnect redemption that resolves
// later in the same page load. A fragment-free load still sets `hasRead` on
// its first (null) readDaemonTokenOnce() call, and that must NOT block a
// later seed — otherwise a silent-reconnect redemption can never install its
// token into this store, and DaemonBackend.openSocket (which reads this
// store directly rather than taking a token prop) authenticates with null.
export function seedDaemonToken(token: string): void {
  if (cachedToken !== null) return
  cachedToken = token
  hasRead = true
}

// Test-only: restores first-read semantics so each test seeds and reads its
// own token value independently of module-singleton state from earlier tests.
export function resetTokenStoreForTests(): void {
  cachedToken = null
  hasRead = false
}
