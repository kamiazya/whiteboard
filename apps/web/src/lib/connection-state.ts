import type { BrowserPersistenceState } from './browser-persistence-state.js'
import type { SyncStatus } from './document-sync-types.js'
import type { ReplicaSaveHealth } from './replica-save-queue.js'
import type { StorageHealth } from './storage-health.js'

/**
 * Health of the live document session a daemon-kept page runs.
 * `write-failed`: a write the daemon did not take is outstanding — the
 * transport may well be up, so it is not a reconnect.
 * `not-opened`: the load was refused or failed before any session was built,
 * so no editor mounted and nothing can have been typed. It reads as sync-off
 * wherever the state is DRAWN (`isSyncOff`), and holds nothing wherever the
 * question is what this tab alone holds (`isNotKeeping`) — a session that ran
 * and was then refused (`sync-off`) may strand edits; this one cannot.
 */
export type SessionHealth = 'synced' | 'reconnecting' | 'sync-off' | 'write-failed' | 'not-opened'

/**
 * What a daemon-kept page reports from what its session knows. A refusal —
 * the credential rejected (`sync-off`), or a load refused or failed, where no
 * session runs at all (`not-opened`) — outranks everything, because
 * reconnecting is the only way out of it; then a write that did not land (the session's persistence account, not
 * its `error` status, which an unreadable document reports too); synced is
 * claimed only while the session is connected; everything else — `idle`,
 * `error` — folds in with reconnecting, whose copy makes no claim.
 */
export function sessionHealthOf(
  authError: boolean,
  status: SyncStatus,
  persistence: BrowserPersistenceState,
  noSession = false,
): SessionHealth {
  if (authError) return 'sync-off'
  if (noSession) return 'not-opened'
  if (persistence.kind === 'degraded' && persistence.reason === 'write-failed')
    return 'write-failed'
  return status === 'connected' ? 'synced' : 'reconnecting'
}

/**
 * Two axes, not one enum: WHO KEEPS the workspace, and whether that keeper
 * is keeping. One four-value union would make `browser` and `reconnecting`
 * alternatives of each other, unable to say
 * "daemon-kept, but the daemon is unreachable while the browser holds the
 * live replica" — the resting state promotion (a browser workspace merged
 * into a daemon) leaves behind.
 *
 * Each keeper's health is the health IT can answer for. The daemon's is the
 * live session (transport liveness, plus whether its writes are landing —
 * the backend reports both outcomes, a landed write and a failed one). The
 * browser's is its storage: whether the writes behind the open document are
 * landing (`StorageHealth`, judged from the persistence facts the session
 * reports). Both are quiet when healthy; the shell mark draws only a
 * condition.
 *
 * `replica` is the daemon-kept workspace read offline: the daemon is
 * unreachable, so what keeps the edits until it returns is this browser's
 * replica copy, and its health is whether the last append to that copy
 * landed. It is an arm of its own rather than `daemon` with another session
 * value because no session runs — and a refused append there is the one
 * copy of the edits failing, which the tab-wide signals must see, the tab
 * icon and app badge among them (`faviconStatusOf`, `createAppBadgeWriter`).
 */
export type ConnectionState =
  | { readonly keeper: 'browser'; readonly storage: StorageHealth }
  | { readonly keeper: 'daemon'; readonly session: SessionHealth }
  | { readonly keeper: 'replica'; readonly storage: ReplicaSaveHealth }

/**
 * The one state whose only exit is reconnecting — what the shell's attention
 * dot keys on. A transient reconnect is not it: that recovers on its own. A
 * session never opened has the same only exit, so it is drawn the same.
 */
export function isSyncOff(state: ConnectionState): boolean {
  return (
    state.keeper === 'daemon' && (state.session === 'sync-off' || state.session === 'not-opened')
  )
}

/**
 * The keeper is not keeping: a refused browser write, a rejected daemon
 * session, a daemon write that has not landed, or a refused append to the
 * offline replica. All draw the broken mark, because all mean the same thing
 * to the person holding the document — what they type now is in this tab
 * and nowhere else.
 */
export function isNotKeeping(state: ConnectionState): boolean {
  if (state.keeper === 'daemon') {
    return state.session === 'sync-off' || state.session === 'write-failed'
  }
  return state.storage === 'failed'
}

/**
 * The state asks for the person's return and for them not to leave yet: the
 * keeper is not keeping, or a browser edit has stayed unsaved past any write
 * (`stuck`). What the app badge and the leave prompt both key on, so the
 * badge never says "come back" to a tab that would close without asking.
 * Unlike the states `isNotKeeping` names, a stuck edit does not hold a
 * waiting reload (`nothingHeldInTab`): reloading is its panel's own way out.
 */
export function asksForReturn(state: ConnectionState): boolean {
  return isNotKeeping(state) || (state.keeper === 'browser' && state.storage === 'stuck')
}

/**
 * What a live region says when the keeper stops keeping, in words about that
 * keeper; empty while it keeps. Spoken only for these and for sync off, never
 * for a reconnect blip, which read aloud mid-sentence is noise.
 */
export function notKeepingAnnouncement(state: ConnectionState | null): string {
  if (state === null) return ''
  if (isSyncOff(state)) return 'Live sync off'
  if (!isNotKeeping(state)) return ''
  return state.keeper === 'daemon' ? 'Changes not saved yet' : 'Writing to this browser failed'
}
