/**
 * What a move of a workspace record between this browser and a keeper tells
 * the person when it threw, by what failed — one policy for the replica pull,
 * the replica push, preparing and running the move to the daemon, and a
 * keeper accepting a transferred record, each supplying its sentences.
 *
 * Every such `try` covers the network AND this device's own storage — the
 * stored copy, the IndexedDB write, the CRDT bytes. Reporting all of it as an
 * unreachable keeper sends someone whose disk is full to check a connection
 * that works, so only a `FetchFailedError` — what `reach` makes of a fetch's
 * rejection where the fetch is called — is reported that way, and every
 * device-side arm leaves a log record naming the error, since the reason a
 * person reads carries none of it.
 */

import { FetchFailedError } from '@kamiazya/whiteboard-daemon-client/api-contracts/read-body'
import { isStoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import type { AppLogger } from './app-logger.js'
import { ReplicaKeyWithheldError } from './sealed-document-store.js'

export type TransferFailure =
  /**
   * The daemon was reached, but this build's session key for the workspace
   * is withheld (`ReplicaKeyWithheldError`) — a reconnect question, never a
   * network one. Kept distinct from `'failed'` so a caller can tell a member
   * to reconnect instead of retrying the request.
   */
  { kind: 'withheld' } | { kind: 'failed'; reason: string }

/** One flow's sentences: what the person reads, and what the log records. */
export interface FailureCopy {
  network: string
  unreadable: string
  device: string
  unreadableLog: string
  deviceLog: string
}

export const PULL_FAILURE_COPY: FailureCopy = {
  network: 'Could not reach the daemon (network error).',
  // Worded like the Browser keeper's own unreadable-workspace notice.
  unreadable:
    "This browser's copy of this workspace could not be read, so the pull was not stored.",
  device: 'The pulled workspace could not be stored on this device.',
  unreadableLog: 'stored replica could not be read; pull abandoned',
  deviceLog: 'replica pull failed on this device',
}

export const PUSH_FAILURE_COPY: FailureCopy = {
  network: 'Could not reach the daemon (network error).',
  unreadable:
    "This browser's copy of this workspace could not be read, so its edits were not sent.",
  device: 'The edits on this device could not be prepared for sending.',
  unreadableLog: 'stored replica could not be read; push abandoned',
  deviceLog: 'replica push failed on this device',
}

export function describeTransferFailure(
  err: unknown,
  copy: FailureCopy,
  context: { log: AppLogger; fields: Readonly<Record<string, string>> },
): TransferFailure {
  const { log, fields } = context
  if (err instanceof ReplicaKeyWithheldError) return { kind: 'withheld' }
  if (isStoredDocumentUnreadableError(err)) {
    log.warn(copy.unreadableLog, { ...fields })
    return { kind: 'failed', reason: copy.unreadable }
  }
  // Every flow using this is safe to re-run once the keeper answers.
  if (err instanceof FetchFailedError) return { kind: 'failed', reason: copy.network }
  log.warn(copy.deviceLog, { ...fields, name: errorName(err) })
  return { kind: 'failed', reason: copy.device }
}

/** The error's name for a log record — never its message, which may carry content. */
export function errorName(err: unknown): string {
  return err instanceof Error || err instanceof DOMException ? err.name : typeof err
}
