import type { StorageHealth } from './storage-health.js'

/** Health of the live document session a daemon-kept page runs. */
export type SessionHealth = 'synced' | 'reconnecting' | 'sync-off'

/**
 * Two axes, not one enum: WHO KEEPS the workspace, and whether that keeper
 * is keeping. They used to share one four-value union, which made `browser`
 * and `reconnecting` alternatives of each other and so could not say
 * "daemon-kept, but the daemon is unreachable while the browser holds the
 * live replica" — the resting state promotion (a browser workspace merged
 * into a daemon) leaves behind.
 *
 * Each keeper's health is the health IT can answer for. The daemon's is the
 * live session (derived from transport liveness — its writes are sent, never
 * acknowledged). The browser's is its storage: whether the writes behind the
 * open document are landing (`StorageHealth`, judged from the persistence
 * facts the session reports). Both are quiet when healthy; the shell mark
 * draws only a condition.
 */
export type ConnectionState =
  | { readonly keeper: 'browser'; readonly storage: StorageHealth }
  | { readonly keeper: 'daemon'; readonly session: SessionHealth }

/**
 * The one state whose only exit is re-pairing — what the shell's attention
 * dot keys on. A transient reconnect is not it: that recovers on its own.
 */
export function isSyncOff(state: ConnectionState): boolean {
  return state.keeper === 'daemon' && state.session === 'sync-off'
}

/**
 * The keeper is not keeping: a refused browser write, or a rejected daemon
 * session. Both draw the broken mark, because both mean the same thing to
 * the person holding the document — what they type now is in this tab and
 * nowhere else.
 */
export function isNotKeeping(state: ConnectionState): boolean {
  return state.keeper === 'browser' ? state.storage === 'failed' : state.session === 'sync-off'
}
