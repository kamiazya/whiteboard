import type { FaviconStatus } from './favicon.js'

/**
 * OS-level counterpart of the favicon's status dot: the installed app's
 * icon shows a badge while there are unsaved changes, and nothing
 * otherwise (BRAND.md — the badge can't carry color, so it only encodes
 * the one state that asks for the user's return). No-op where the Badging
 * API is missing; the promise failures are ignored because a badge is a
 * hint, never load-bearing.
 */
export function updateAppBadge(status: FaviconStatus): void {
  if (status === 'unsaved') {
    void navigator.setAppBadge?.().catch(() => {})
    return
  }
  void navigator.clearAppBadge?.().catch(() => {})
}
