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

// Test-only: restores first-read semantics so each test seeds and reads its
// own token value independently of module-singleton state from earlier tests.
export function resetTokenStoreForTests(): void {
  cachedToken = null
  hasRead = false
}
