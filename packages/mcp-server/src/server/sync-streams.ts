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
    streams.delete(streamId)
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

/** Holds a stream open under the id its first frame carried. */
export function registerSyncStream(streamId: string, stream: SyncStream): void {
  streams.set(streamId, stream)
}

/** Forgets a stream that closed. */
export function unregisterSyncStream(streamId: string): void {
  streams.delete(streamId)
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

/**
 * Ends every stream a user holds (ADR-0049 decision 4, ADR-0042): losing access
 * — deactivated, or removed from a workspace — takes effect on the stream they
 * already have open, not only on the requests they make next. Membership is
 * checked when a stream subscribes, so a closed stream is how the client
 * learns to ask again, and asking again is refused where it no longer may.
 */
export function endSyncStreamsOf(userId: string): void {
  for (const [streamId, stream] of streams) {
    if (stream.userId !== userId) continue
    streams.delete(streamId)
    stream.end()
    log.info({ streamId }, 'sync stream ended: its user lost access')
  }
}

// Test-only: the module-level registry outlives a single app instance, so a
// test that opens a stream would otherwise leak a subscriber into the next one.
export function resetSyncStreamsForTests(): void {
  streams.clear()
}
