/** Health of the live document session a daemon-kept page runs. */
export type SessionHealth = 'synced' | 'reconnecting' | 'sync-off'

/**
 * Two axes, not one enum: WHO KEEPS the workspace, and — daemon-kept only —
 * whether the live session is healthy. They used to share one four-value
 * union, which made `browser` and `reconnecting` alternatives of each other
 * and so could not say "daemon-kept, but the daemon is unreachable while the
 * browser holds the live replica" — the resting state promotion (a browser
 * workspace merged into a daemon) leaves behind. A browser-kept workspace has
 * no daemon session, so the browser arm carries no health field at all.
 */
export type ConnectionState =
  | { readonly keeper: 'browser' }
  | { readonly keeper: 'daemon'; readonly session: SessionHealth }

/**
 * The one state whose only exit is re-pairing — what the shell's attention
 * dot keys on. A transient reconnect is not it: that recovers on its own.
 */
export function isSyncOff(state: ConnectionState): boolean {
  return state.keeper === 'daemon' && state.session === 'sync-off'
}
