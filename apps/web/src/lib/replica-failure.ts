/**
 * What a move of a workspace record between this browser and a keeper tells
 * the person when it threw, by what failed — one policy for the replica pull,
 * the replica push and the move to the daemon, each supplying its sentences.
 *
 * Every such `try` covers the network AND this device's own storage — the
 * stored copy, the IndexedDB write, the CRDT bytes. Reporting all of it as an
 * unreachable keeper sends someone whose disk is full to check a connection
 * that works, so only a `FetchFailedError` — what `reach` makes of a fetch's
 * rejection where the fetch is called — is reported that way, and every
 * device-side arm leaves a log record naming the error, since the reason a
 * person reads carries none of it.
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

/**
 * A fetch, or the read of its body, rejected: the keeper was not reached.
 *
 * Named at the call because a failed fetch rejects with a bare `TypeError`,
 * the same class a defect in this device's own reads and writes throws — so
 * by the time a `catch` sees one, the class can no longer say which it was.
 */
class FetchFailedError extends Error {
  override readonly name = 'FetchFailedError'
  constructor(cause: unknown) {
    super('the keeper could not be reached', { cause })
  }
}

/** `attempt`, with its rejection named a `FetchFailedError`. */
export async function reach<T>(attempt: Promise<T>): Promise<T> {
  try {
    return await attempt
  } catch (err) {
    throw new FetchFailedError(err)
  }
}

export function describeFailure(
  err: unknown,
  copy: FailureCopy,
  context: { log: AppLogger; fields: Readonly<Record<string, string>> },
): ReplicaFailure {
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
