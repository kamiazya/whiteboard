// The sync streams this instance holds open, and what is sent down them.
//
// The registry of streams (`streams`), the document-level fan-out and the
// counts the status surfaces read — everything about the streams that is not
// an HTTP request. `routes/sync-sse.ts` owns the transport (opening a stream,
// subscribe and `client_ready` POSTs) and registers each stream here; the
// audience vocabulary (`sync-audience.ts`), the workspace tail and the
// notifier read and write through these functions without importing a route.

import {
  WORKSPACE_DOC_KEY_PREFIX,
  workspaceDocKey,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
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

export interface SyncStream {
  /** Keyed by the doc key exactly as the client subscribed with it. */
  docs: Map<string, SyncStreamDoc>
  send: (event: string, data: string) => void
  /** The user who opened it, where the keeper knows people; null otherwise. */
  userId: string | null
  end: () => void
}

const streams = new Map<string, SyncStream>()

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
      if (key.startsWith(WORKSPACE_DOC_KEY_PREFIX))
        ids.add(key.slice(WORKSPACE_DOC_KEY_PREFIX.length))
    }
  }
  return [...ids]
}

export function docKey(workspaceId: string, path: string): string {
  return `${workspaceId}/${path}`
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
  for (const stream of streams.values()) {
    for (const [as, entry] of stream.docs) {
      if (entry.key !== key) continue
      const payload: SyncUpdateEvent = { doc: as, update: encoded }
      stream.send('update', JSON.stringify(payload))
    }
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
  sendText(docKey(workspaceId, path), raw, () => true)
}

function sendText(key: string, raw: string, admits: (entry: SyncStreamDoc) => boolean): void {
  for (const stream of streams.values()) {
    for (const [as, entry] of stream.docs) {
      if (entry.key !== key || !admits(entry)) continue
      const payload: SyncMessageEvent = { doc: as, raw }
      stream.send('message', JSON.stringify(payload))
    }
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
  sendText(docKey(workspaceId, path), raw, (entry) => entry.ready)
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
