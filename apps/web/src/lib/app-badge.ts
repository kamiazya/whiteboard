import { type ConnectionState, isNotKeeping } from './connection-state.js'

/**
 * OS-level counterpart of the tab icon: the installed app's icon shows a
 * badge while the keeper is not keeping — what the person typed is in this
 * tab and nowhere else — and nothing otherwise (BRAND.md — the badge can't
 * carry color, so it only encodes the one state that asks for the user's
 * return). Read off the connection state rather than the favicon's status,
 * because the icon draws a refused browser write as `offline` and that is
 * exactly such a state. No-op where the Badging API is missing; the promise
 * failures are ignored because a badge is a hint, never load-bearing.
 */
export function updateAppBadge(state: ConnectionState | null): void {
  if (state !== null && isNotKeeping(state)) {
    void navigator.setAppBadge?.().catch(() => {})
    return
  }
  void navigator.clearAppBadge?.().catch(() => {})
}
