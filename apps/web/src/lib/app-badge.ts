import { type ConnectionState, isNotKeeping } from './connection-state.js'

/**
 * OS-level counterpart of the tab icon: the installed app's icon shows a
 * badge while the state asks for the user's return — the keeper is not
 * keeping (what they typed is in this tab and nowhere else), or a browser
 * edit is stuck unsaved — and nothing otherwise (BRAND.md — the badge can't
 * carry color, so it only encodes that one ask). Read off the connection
 * state rather than the favicon's status, because the icon draws a refused
 * browser write as `offline` and that is exactly such a state. No-op where
 * the Badging API is missing; the promise failures are ignored because a
 * badge is a hint, never load-bearing.
 */
export function updateAppBadge(state: ConnectionState | null): void {
  if (state !== null && asksForReturn(state)) {
    void navigator.setAppBadge?.().catch(() => {})
    return
  }
  void navigator.clearAppBadge?.().catch(() => {})
}

function asksForReturn(state: ConnectionState): boolean {
  return isNotKeeping(state) || (state.keeper === 'browser' && state.storage === 'stuck')
}
