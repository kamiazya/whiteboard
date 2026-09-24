import type { BrowserPersistenceState } from './browser-persistence-state.js'
import type { SyncStatus } from './document-sync-types.js'
import type { StorageHealth } from './storage-health.js'

/**
 * Health of the live document session a daemon-kept page runs.
 * `write-failed`: a write the daemon did not take is outstanding — the
 * transport may well be up, so it is not a reconnect.
 */
export type SessionHealth = 'synced' | 'reconnecting' | 'sync-off' | 'write-failed'

/**
 * What a daemon-kept page reports from what its session knows. An auth
 * rejection outranks everything, because re-pairing is the only way out of
 * it; then a write that did not land (the session's persistence account, not
 * its `error` status, which an unreadable document reports too); synced is
 * claimed only while the session is connected; everything else — `idle`,
 * `error` — folds in with reconnecting, whose copy makes no claim.
 */
export function sessionHealthOf(
  authError: boolean,
  status: SyncStatus,
  persistence: BrowserPersistenceState,
): SessionHealth {
  if (authError) return 'sync-off'
  if (persistence.kind === 'degraded' && persistence.reason === 'write-failed')
    return 'write-failed'
  return status === 'connected' ? 'synced' : 'reconnecting'
}

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
 * The keeper is not keeping: a refused browser write, a rejected daemon
 * session, or a daemon write that has not landed. All draw the broken mark,
 * because all mean the same thing to the person holding the document — what
 * they type now is in this tab and nowhere else.
 */
export function isNotKeeping(state: ConnectionState): boolean {
  return state.keeper === 'browser'
    ? state.storage === 'failed'
    : state.session === 'sync-off' || state.session === 'write-failed'
}

/**
 * What a live region says when the keeper stops keeping, in words about that
 * keeper; empty while it keeps. Spoken only for these, never for a reconnect
 * blip, which read aloud mid-sentence is noise.
 */
export function notKeepingAnnouncement(state: ConnectionState | null): string {
  if (state === null || !isNotKeeping(state)) return ''
  if (state.keeper === 'browser') return 'Writing to this browser failed'
  return state.session === 'sync-off' ? 'Live sync off' : 'Changes not saved yet'
}
