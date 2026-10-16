import { asksForReturn, type ConnectionState } from './connection-state.js'

/**
 * OS-level counterpart of the tab icon: the installed app's icon shows a
 * badge while a window's state asks for the user's return (`asksForReturn`)
 * and nothing otherwise. The badge carries no colour or count on every
 * platform, so it encodes that one ask and nothing finer. Read off the
 * connection state rather than the favicon's status, because the icon draws
 * a refused browser write as `offline` and that is exactly such a state.
 *
 * The badge belongs to the installed app, so every window of it writes the
 * same one. A writer therefore clears only a badge it set itself: a healthy
 * window must not wipe the ask another window raised over edits it still
 * holds. `write(null)` lets go — the window no longer has a state to report.
 *
 * No-op where the Badging API is missing; a rejected call is ignored, since
 * a badge is a hint, never load-bearing.
 */
export function createAppBadgeWriter(): { write: (state: ConnectionState | null) => void } {
  let raised = false
  return {
    write(state) {
      if (state !== null && asksForReturn(state)) {
        raised = true
        void navigator.setAppBadge?.().catch(ignore)
        return
      }
      if (!raised) return
      raised = false
      void navigator.clearAppBadge?.().catch(ignore)
    },
  }
}

function ignore(): void {}
