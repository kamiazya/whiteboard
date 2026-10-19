// The sync streams this instance holds open, and what is sent down them.
//
// The registry of streams (`streams`), the document-level fan-out and the
// counts the status surfaces read — everything about the streams that is not
// an HTTP request. `routes/sync-sse.ts` owns the transport (opening a stream,
// subscribe and `client_ready` POSTs) and registers each stream here; the
// audience vocabulary (`sync-audience.ts`), the workspace tail and the
// notifier read and write through these functions without importing a route.

import { MAX_FILE_UPLOAD_BYTES } from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import {
  documentSyncKey,
  workspaceDocKey,
  workspaceHandleOfSyncKey,
  workspaceIdOfSyncKey,
} from '@kamiazya/whiteboard-daemon-client/sync-key'
import type {
  SyncMessageEvent,
  SyncUpdateEvent,
} from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { getLogger } from './log.js'

const log = getLogger('sync-sse')

/**
 * `ready` says the stream has signalled `client_ready` for that document. A
 * viewport request is withheld until then and replayed from cache on ready —
 * a pre-ready client cannot apply a viewport, and sending it both now and on
 * replay would deliver it twice.
 *
 * It is a field on the subscription rather than a second set keyed by the same
 * document, so readiness cannot outlive the subscription it describes:
 * unsubscribing is one delete, with nothing left to forget to clear.
 */
export interface SyncStreamDoc {
  ready: boolean
  /**
   * The key canonicalised: registries and broadcasts name a workspace by id,
   * while the map holding this entry is keyed as the client subscribed — by
   * whatever handle its address carries (ADR-0019), which is also what it
   * routes events by. Two spellings of one document are two subscriptions.
   */
  key: string
}

/**
 * One frame down a stream, as the contract the page parses it with names it.
 * The payload stays an object until the transport serialises it, so a writer
 * cannot hand the page an envelope the schema would drop.
 */
type SyncFrame =
  | { event: 'update'; data: SyncUpdateEvent }
  | { event: 'message'; data: SyncMessageEvent }

export interface SyncStream {
  /** Keyed by the doc key exactly as the client subscribed with it. */
  docs: Map<string, SyncStreamDoc>
  send: (frame: SyncFrame) => void
  /** The user who opened it, where the keeper knows people; null otherwise. */
  userId: string | null
  /**
   * Whether the stream's user still reaches a workspace, asked before each
   * broadcast is sent down it. Absent where nobody can lose access (the local
   * daemon), and then a broadcast is sent at once.
   */
  admits?: (workspaceId: string) => Promise<boolean>
  /**
   * The sign-in session that opened it, by the hash its token is stored
   * under (`sessionKeyOf`), so the registry never holds a live credential;
   * absent for a stream opened on any other grant. The membership
   * re-check cannot see a session end — the person is still a member — so
   * ending the session ends its streams by this (`endSyncStreamsOfSession`).
   */
  session?: string
  end: () => void
}

/**
 * Each re-checked stream's broadcasts, in the order they were made: the check
 * is a read, and two broadcasts resolving out of order would deliver a
 * workspace's updates out of order.
 */
const deliveries = new WeakMap<SyncStream, Promise<void>>()

/**
 * The access reads one broadcast makes, by user: a user following a workspace
 * from several tabs is read once per broadcast, not once per stream. Nothing
 * outlives the broadcast, so a removal is seen by the next one after it.
 *
 * ponytail: one indexed read (~0.25ms, 200 users x 20 workspaces) per
 * subscribed user per broadcast; a short-lived cache or a membership epoch if
 * busy workspaces with many followers make that show on the serving loop.
 */
type AccessReads = Map<string, Promise<boolean>>

function admitted(
  reads: AccessReads,
  stream: SyncStream,
  admits: NonNullable<SyncStream['admits']>,
  workspaceId: string,
): Promise<boolean> {
  const key = stream.userId ?? ''
  let read = reads.get(key)
  if (read === undefined) {
    read = admits(workspaceId).catch((err: unknown) => {
      log.warning({ workspaceId, err }, 'sync stream access re-check failed')
      return false
    })
    reads.set(key, read)
  }
  return read
}

/**
 * Send `frames` down a stream, re-checking its user's access first where they
 * can lose it. Removal and deactivation also end streams directly
 * (`endSyncStreamsOf`), but only on the instance that handled them; this is
 * what reaches a stream held by another instance, or a change the operator's
 * CLI wrote from another process. A read that fails ends the stream too: the
 * client reconnects, and its resubscribe is decided afresh.
 */
function deliver(
  streamId: string,
  stream: SyncStream,
  workspaceId: string,
  frames: readonly SyncFrame[],
  reads: AccessReads,
): void {
  const admits = stream.admits
  if (admits === undefined) {
    for (const frame of frames) stream.send(frame)
    return
  }
  // Asked now, in broadcast order, and awaited behind this stream's earlier
  // deliveries so frames keep that order whatever order the reads settle in.
  const read = admitted(reads, stream, admits, workspaceId)
  const previous = deliveries.get(stream) ?? Promise.resolve()
  const next = previous.then(async () => {
    const decision = await read
    if (streams.get(streamId) !== stream) return
    if (decision) {
      for (const frame of frames) stream.send(frame)
      return
    }
    forget(streamId)
    stream.end()
    log.info(
      { streamId, workspaceId },
      'sync stream ended: its user no longer reaches the workspace',
    )
  })
  deliveries.set(stream, next)
}

const streams = new Map<string, SyncStream>()

/**
 * How many streams server mode holds open for one user, and in all. The web
 * app keeps ONE stream per browser profile, shared across its tabs through a
 * SharedWorker, and one per tab only where SharedWorker is missing (Chrome on
 * Android) — so a person on a few devices with a few such tabs stays far
 * under the per-user cap, while a caller opening streams in a loop is stopped
 * long before the keeper's memory is. The local daemon has one person, and
 * applies neither.
 */
export const SYNC_STREAM_CAPS = { perUser: 16, total: 1024 } as const
export type SyncStreamCaps = { perUser: number; total: number }

/** The largest update frame: a Loro update is capped at the content body
 *  limit, and travels base64-encoded. */
const LARGEST_UPDATE_FRAME_CHARS = Math.ceil(MAX_FILE_UPLOAD_BYTES / 3) * 4

/**
 * How much a stream may have written and not yet delivered, in characters of
 * frame data (ASCII — JSON around base64 — so one byte each). A reader that
 * stops reading would otherwise hold a copy of every broadcast. Past it the
 * stream is ended; the client reconnects, resubscribes and reads what it
 * missed from the keeper, so a slow reader loses nothing. Two of the largest
 * update frames fit under it, with room for the envelope.
 */
export const MAX_QUEUED_STREAM_CHARS = 2 * LARGEST_UPDATE_FRAME_CHARS + 1024 * 1024

/**
 * Which cap a new stream for `userId` would pass, if any. Checked before the
 * stream registers, so opens racing each other may overshoot by however many
 * are in flight at once — a bound on a flood, not an exact count.
 */
export function syncStreamCapReached(
  userId: string,
  caps: SyncStreamCaps,
): 'per_user' | 'total' | null {
  if (streams.size >= caps.total) return 'total'
  let held = 0
  for (const stream of streams.values()) if (stream.userId === userId) held++
  return held >= caps.perUser ? 'per_user' : null
}

/**
 * How much undelivered frame data (characters, as `MAX_QUEUED_STREAM_CHARS`)
 * all of one user's streams may hold together, and all of this instance's.
 * Each stream stays under its own ceiling, so without these a user holding
 * `SYNC_STREAM_CAPS.perUser` streams and reading none would pin that many
 * ceilings' worth. Past either, the oldest stream holding a queue — that
 * user's, or anyone's — is ended until the total fits again; like any ended
 * stream, its page reconnects and reads what it missed from the keeper. A
 * user's budget still fits one stream at its ceiling, so a single slow reader
 * is ended by its own ceiling first.
 */
const SYNC_QUEUE_BUDGET = {
  perUser: 2 * MAX_QUEUED_STREAM_CHARS,
  total: 8 * MAX_QUEUED_STREAM_CHARS,
} as const
export type SyncQueueBudget = { perUser: number; total: number }

/** What each registered stream has written and its reader not yet taken. */
const queued = new Map<string, number>()
const queuedByUser = new Map<string, number>()
let queuedTotal = 0

function addQueued(streamId: string, userId: string | null, chars: number): void {
  queued.set(streamId, (queued.get(streamId) ?? 0) + chars)
  queuedTotal += chars
  if (userId !== null) queuedByUser.set(userId, (queuedByUser.get(userId) ?? 0) + chars)
}

// Removes a stream and everything it was counted for, so a budget is freed
// the moment a stream ends, not when its writes eventually settle.
function forget(streamId: string): void {
  const stream = streams.get(streamId)
  streams.delete(streamId)
  const held = queued.get(streamId) ?? 0
  queued.delete(streamId)
  if (held === 0 || stream === undefined) return
  queuedTotal -= held
  if (stream.userId === null) return
  const left = (queuedByUser.get(stream.userId) ?? 0) - held
  if (left > 0) queuedByUser.set(stream.userId, left)
  else queuedByUser.delete(stream.userId)
}

// The oldest registered stream holding a queue, of `userId` when given.
function oldestQueued(userId?: string): [string, SyncStream] | undefined {
  for (const entry of streams) {
    if (userId !== undefined && entry[1].userId !== userId) continue
    if ((queued.get(entry[0]) ?? 0) > 0) return entry
  }
  return undefined
}

function endForBudget(streamId: string, stream: SyncStream, over: 'per_user' | 'total'): void {
  forget(streamId)
  stream.end()
  log.warning({ streamId, over }, 'sync stream ended: its readers fell too far behind together')
}

/**
 * Counts `chars` just written down a stream against the budgets, ending the
 * oldest queued streams past either. The stream itself may be among them.
 */
export function chargeSyncStreamQueue(
  streamId: string,
  chars: number,
  budget: SyncQueueBudget = SYNC_QUEUE_BUDGET,
): void {
  const stream = streams.get(streamId)
  if (stream === undefined) return
  addQueued(streamId, stream.userId, chars)
  const userId = stream.userId
  while (userId !== null && (queuedByUser.get(userId) ?? 0) > budget.perUser) {
    const oldest = oldestQueued(userId)
    if (oldest === undefined) break
    endForBudget(oldest[0], oldest[1], 'per_user')
  }
  while (queuedTotal > budget.total) {
    const oldest = oldestQueued()
    if (oldest === undefined) break
    endForBudget(oldest[0], oldest[1], 'total')
  }
}

/** Releases `chars` a stream's reader has taken. A stream already ended was released whole. */
export function releaseSyncStreamQueue(streamId: string, chars: number): void {
  const held = queued.get(streamId)
  const stream = streams.get(streamId)
  if (held === undefined || stream === undefined) return
  const taken = Math.min(held, chars)
  queued.set(streamId, held - taken)
  queuedTotal -= taken
  if (stream.userId === null) return
  const left = (queuedByUser.get(stream.userId) ?? 0) - taken
  if (left > 0) queuedByUser.set(stream.userId, left)
  else queuedByUser.delete(stream.userId)
}

/** Holds a stream open under the id its first frame carried. */
export function registerSyncStream(streamId: string, stream: SyncStream): void {
  streams.set(streamId, stream)
}

/** Forgets a stream that closed. */
export function unregisterSyncStream(streamId: string): void {
  forget(streamId)
}

/** The stream an id names on this instance, if it holds one. */
export function syncStreamById(streamId: string): SyncStream | undefined {
  return streams.get(streamId)
}

/** How many sync streams are held open right now — each one a page being served. */
export function openSyncStreamCount(): number {
  return streams.size
}

/** The pages being served, and how many of them have signalled `client_ready` for a document. */
export function syncStreamStats(): { connected: number; ready: number } {
  let ready = 0
  for (const stream of streams.values()) {
    if ([...stream.docs.values()].some((doc) => doc.ready)) ready++
  }
  return { connected: streams.size, ready }
}

/**
 * The workspaces a stream here subscribed to at workspace granularity — the
 * record the workspace tail follows. A per-document key carries text only.
 */
export function sseSubscribedWorkspaceIds(): string[] {
  const ids = new Set<string>()
  for (const stream of streams.values()) {
    for (const { key } of stream.docs.values()) {
      const workspaceId = workspaceIdOfSyncKey(key)
      if (workspaceId !== null) ids.add(workspaceId)
    }
  }
  return [...ids]
}

export function docKey(workspaceId: string, path: string): string {
  return documentSyncKey(workspaceId, path)
}

function toBase64(bytes: Uint8Array): string {
  // Node-only file (mcp-server builds with `platform: 'node'`), so this takes
  // the native conversion rather than building a string one byte at a time.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/**
 * Fan a WORKSPACE-DOCUMENT update out to every stream subscribed at
 * workspace granularity (`workspace:<id>` keys). The only binary fan-out:
 * the per-document one is retired — a per-document subscriber handed
 * workspace-document bytes (or the reverse) would be importing a stranger's
 * history, so per-document keys carry text events only.
 */
export function sseBroadcastWorkspaceUpdate(workspaceId: string, update: Uint8Array): void {
  const key = workspaceDocKey(workspaceId)
  const encoded = toBase64(update)
  const reads: AccessReads = new Map()
  for (const [streamId, stream] of streams) {
    const frames: SyncFrame[] = []
    for (const [as, entry] of stream.docs) {
      if (entry.key !== key) continue
      frames.push({ event: 'update', data: { doc: as, update: encoded } })
    }
    if (frames.length > 0) deliver(streamId, stream, workspaceId, frames, reads)
  }
}

/**
 * Fan a server text message (version_created, restore_started, …) out to
 * SSE subscribers, wrapped with the document it belongs to. One stream
 * serves many documents, so an unaddressed frame would be applied to
 * whichever document happened to be listening — a restore for one document
 * landing on another.
 */
export function sseBroadcastText(workspaceId: string, path: string, raw: string): void {
  sendText(workspaceId, path, raw, () => true)
}

function sendText(
  workspaceId: string,
  path: string,
  raw: string,
  wants: (entry: SyncStreamDoc) => boolean,
): void {
  const key = docKey(workspaceId, path)
  const reads: AccessReads = new Map()
  for (const [streamId, stream] of streams) {
    const frames: SyncFrame[] = []
    for (const [as, entry] of stream.docs) {
      if (entry.key !== key || !wants(entry)) continue
      frames.push({ event: 'message', data: { doc: as, raw } })
    }
    if (frames.length > 0) deliver(streamId, stream, workspaceId, frames, reads)
  }
}

/**
 * How many streams are subscribed to one document, or only those that have
 * signalled `client_ready` for it.
 */
export function sseClientCount(workspaceId: string, path: string, readyOnly: boolean): number {
  const key = docKey(workspaceId, path)
  let count = 0
  for (const stream of streams.values()) {
    for (const entry of stream.docs.values()) {
      if (entry.key === key && (!readyOnly || entry.ready)) count++
    }
  }
  return count
}

/** Like sseBroadcastText, but only to streams that have signalled client_ready. */
export function sseBroadcastTextToReady(workspaceId: string, path: string, raw: string): void {
  sendText(workspaceId, path, raw, (entry) => entry.ready)
}

// Whether a stream follows `workspaceId`, by any key. Keys are canonical, so
// a per-document key's handle IS the workspace id.
function follows(stream: SyncStream, workspaceId: string): boolean {
  for (const { key } of stream.docs.values()) {
    if (workspaceHandleOfSyncKey(key) === workspaceId) return true
  }
  return false
}

/**
 * Ends the streams a user holds (ADR-0049 decision 4, ADR-0042): losing access
 * takes effect on the stream they already have open, not only on the requests
 * they make next. Removed from one workspace, only the streams following it
 * end — one that also follows another is ended whole, and its resubscribe is
 * decided afresh; deactivated (no `workspaceId`), every stream does.
 * Membership is checked when a stream subscribes, so a closed stream is how
 * the client learns to ask again, and asking again is refused where it no
 * longer may.
 */
export function endSyncStreamsOf(userId: string, workspaceId?: string): void {
  for (const [streamId, stream] of streams) {
    if (stream.userId !== userId) continue
    if (workspaceId !== undefined && !follows(stream, workspaceId)) continue
    forget(streamId)
    stream.end()
    log.info({ streamId, workspaceId }, 'sync stream ended: its user lost access')
  }
}

/**
 * Ends the streams a sign-in session opened, when that session ends —
 * signed out, or replaced by a new sign-in in the same browser. Only this
 * instance's: a stream held by another runs until the session's expiry
 * (`grantExpiresAt`), or until its client reconnects and is refused.
 */
export function endSyncStreamsOfSession(session: string): void {
  for (const [streamId, stream] of streams) {
    if (stream.session !== session) continue
    forget(streamId)
    stream.end()
    log.info({ streamId }, 'sync stream ended: the session that opened it ended')
  }
}

// Test-only: the module-level registry outlives a single app instance, so a
// test that opens a stream would otherwise leak a subscriber into the next one.
export function resetSyncStreamsForTests(): void {
  streams.clear()
  queued.clear()
  queuedByUser.clear()
  queuedTotal = 0
}
