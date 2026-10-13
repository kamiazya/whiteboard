/**
 * What a replica pull or push that threw tells the person, by what failed.
 *
 * Both `try` blocks cover the network AND this device's own storage — the
 * stored copy, the IndexedDB write, the CRDT bytes. Reporting all of it as an
 * unreachable daemon sends someone whose disk is full to check a connection
 * that works, so only the error a failed `fetch` raises (a `TypeError`) is
 * reported that way, and every device-side arm leaves a log record naming the
 * error, since the reason a person reads carries none of it.
 */
import { isStoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import type { AppLogger } from './app-logger.js'
import { ReplicaKeyWithheldError } from './sealed-document-store.js'

export type ReplicaFailure =
  /**
   * The daemon was reached, but this build's session key for the workspace
   * is withheld (`ReplicaKeyWithheldError`) — a reconnect question, never a
   * network one. Kept distinct from `'failed'` so a caller can tell a member
   * to reconnect instead of retrying the request.
   */
  { kind: 'withheld' } | { kind: 'failed'; reason: string }

const COPY = {
  pull: {
    // Worded like the Browser keeper's own unreadable-workspace notice.
    unreadable:
      "This browser's copy of this workspace could not be read, so the pull was not stored.",
    device: 'The pulled workspace could not be stored on this device.',
  },
  push: {
    unreadable:
      "This browser's copy of this workspace could not be read, so its edits were not sent.",
    device: 'The edits on this device could not be prepared for sending.',
  },
} as const

export function replicaFailure(
  err: unknown,
  direction: 'pull' | 'push',
  context: { log: AppLogger; daemonBaseUrl: string; workspaceId: string },
): ReplicaFailure {
  const { log, daemonBaseUrl, workspaceId } = context
  if (err instanceof ReplicaKeyWithheldError) return { kind: 'withheld' }
  if (isStoredDocumentUnreadableError(err)) {
    log.warn(`stored replica could not be read; ${direction} abandoned`, {
      daemonBaseUrl,
      workspaceId,
    })
    return { kind: 'failed', reason: COPY[direction].unreadable }
  }
  // A failed fetch rejects with a TypeError and nothing more specific; the
  // pull or push is safe to re-run once the daemon answers.
  if (err instanceof TypeError) {
    return { kind: 'failed', reason: 'Could not reach the daemon (network error).' }
  }
  log.warn(`replica ${direction} failed on this device`, {
    daemonBaseUrl,
    workspaceId,
    name: err instanceof Error ? err.name : typeof err,
  })
  return { kind: 'failed', reason: COPY[direction].device }
}
