/**
 * A development-only way to pin which transport a daemon canvas uses.
 *
 * It exists because the SSE path — and therefore the SharedWorker, and
 * therefore the whole authority replica behind it — is UNREACHABLE in local
 * development. `selectCanvasTransport` chooses SSE only for a secure page
 * talking to an insecure daemon, and "secure" there means the literal `https:`
 * scheme; `pnpm dev` serves `http://localhost`, so every local session picks
 * WebSocket. That is the correct choice (an http page has no mixed-content
 * problem opening `ws://`), which is exactly why it cannot simply be changed.
 *
 * The consequence is that the feature's only real runtime is the hosted https
 * app talking to a local http daemon, which neither `pnpm dev` nor a PR
 * preview reproduces. Without this, verifying anything on that path means
 * hand-patching the selector and remembering to revert — which someone will
 * reinvent every time, and eventually forget to undo.
 *
 * Set it from the console and reload:
 *
 *     localStorage.setItem('whiteboard:dev-transport', 'sse')
 *
 * `localStorage` rather than a query parameter so it survives the SPA's own
 * navigation: a canvas is usually reached by clicking through the index, and
 * a parameter would be gone by the time it mattered.
 */
import type { CanvasTransport } from '@kamiazya/whiteboard-mcp/select-canvas-transport'

export const DEV_TRANSPORT_OVERRIDE_KEY = 'whiteboard:dev-transport'

export function devTransportOverride(): CanvasTransport | undefined {
  // Not a runtime feature check — a build-time constant. Vite substitutes
  // `false` here for a production build, so everything below folds away and
  // the key never reaches the shipped bundle. `scripts/smoke-artifact.mjs`
  // asserts that, because a comment claiming it would not survive a refactor
  // that read the flag some other way.
  if (!import.meta.env.DEV) return undefined
  let pinned: string | null = null
  try {
    pinned = globalThis.localStorage?.getItem(DEV_TRANSPORT_OVERRIDE_KEY) ?? null
  } catch {
    // A storage-partitioned or cookie-blocked context throws on access rather
    // than returning null. A developer aid must never be the reason a page
    // fails to open.
    return undefined
  }
  // Anything unrecognised reads as "no override" rather than as a third
  // transport nothing downstream handles, so a typo fails where it was made.
  return pinned === 'sse' || pinned === 'websocket' ? pinned : undefined
}
