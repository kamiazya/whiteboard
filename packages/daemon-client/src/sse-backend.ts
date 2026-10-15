/**
 * SseBackend: the DocumentBackend every keeper's page syncs through — SSE
 * downstream, ordinary POSTs upstream.
 *
 * The stream is read with `fetch` + `ReadableStream` rather than `EventSource`
 * because a daemon reached through the browser extension is reachable only
 * through the bridge, whose transport is a `fetch`; an `EventSource` or a
 * socket has no way across it. A server-mode keeper
 * authenticates with its session cookie, which a same-origin `fetch` carries
 * too. Reading the body ourselves also works unchanged inside a SharedWorker.
 */

import { apiFetch } from './api-client.js'
import type { SyncWriteRefusal } from './api-contracts/sync-write-refusal.js'
import type { DocumentBackend, DocumentBackendHandlers } from './document-backend-contract.js'
import type { DocListener, SseStreamSource } from './sse-stream-hub.js'
import {
  documentSyncKey,
  routingTransitions,
  SseStreamHub,
  workspaceDocKey,
} from './sse-stream-hub.js'
import { parseServerTextMessage } from './sync-frame-text.js'
import { QueuedWriter } from './write-chain.js'

export interface SseTransport {
  fetch: typeof globalThis.fetch
}

/**
 * Frames held while the keeper's state is being read, and how many reads
 * are still running. One per connection: a read that settles after a
 * disconnect finds a different hold, or none, and releases nothing.
 */
interface FrameHold {
  frames: Uint8Array[]
  reads: number
}

export class SseBackend implements DocumentBackend {
  private readonly baseUrl: string
  private readonly transport: SseTransport | undefined
  private readonly docKey: string

  private readonly streamSource: SseStreamSource | undefined
  private cancelled = false
  private ownedHub: SseStreamHub | null = null
  private unsubscribe: (() => void) | null = null
  private unsubscribeText: (() => void) | null = null
  private handlers: DocumentBackendHandlers | null = null
  /**
   * Frames that arrived while the keeper's state was being read — at open,
   * after a refusal or after a reconnect — or `null` when no read is running.
   * Held rather than applied: they build on the state being read, so they
   * follow it. Overlapping reads share the one hold, released only when the
   * last settles: a snapshot that settles late replaces the caller's copy,
   * and a frame applied before it would go with it.
   */
  private hold: FrameHold | null = null
  /** Bumped by every connect and disconnect, so an open settling late can tell it is stale. */
  private connection = 0
  /** What the source last said of the workspace key's routing. */
  private routed = false
  /** Whether the opening snapshot has settled, before which the open itself reports the connection. */
  private opened = false
  /** The writes this backend sends itself, when its source keeps no copy of them. */
  private writer: QueuedWriter | null = null
  /** Whether the injected source has said a write failed and not yet that it landed. */
  private sourceWritesFailing = false
  private readonly sourceLandings: { landed: () => void; dropped: (reason: Error) => void }[] = []
  /**
   * The key binary frames travel on: always the WORKSPACE document's — the
   * seed snapshot and every update are the workspace record's, and local
   * pushes go to its update route (the per-document binary contract is
   * retired). Text messages (version_created, viewport, restore events)
   * keep flowing on the per-document key — they are addressed per path.
   * The caller scopes its sync session to the open document
   * (`contentDocumentId`).
   */
  private readonly binaryKey: string

  constructor(
    workspaceId: string,
    path: string,
    baseUrl: string,
    transport?: SseTransport,
    streamSource?: SseStreamSource,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.transport = transport
    this.streamSource = streamSource
    this.docKey = documentSyncKey(workspaceId, path)
    this.binaryKey = workspaceDocKey(workspaceId)
  }

  private get fetchFn(): typeof globalThis.fetch {
    return this.transport?.fetch ?? (apiFetch as unknown as typeof globalThis.fetch)
  }

  connect(handlers: DocumentBackendHandlers): void {
    this.cancelled = false
    this.connection += 1
    this.routed = false
    this.opened = false
    this.handlers = handlers
    // Subscribe FIRST, with frames held, and read the keeper's state once the
    // source says the stream carries the workspace: the stream replays
    // nothing, so a snapshot read before that can miss a write no frame will
    // ever carry, and every later frame builds on it. A frame arriving before
    // the snapshot is held for it; one the snapshot already covers imports as
    // nothing.
    const opening = this.holdFrames()
    const source = this.resolveSource()
    this.unsubscribe = source.subscribe(this.binaryKey, this.binaryListener(handlers, opening))
    // Text messages stay per document — and ONLY text: no binary frame
    // travels on a per-document key.
    this.unsubscribeText = source.subscribe(this.docKey, {
      onUpdate: () => {},
      onMessage: (raw) => this.dispatchText(raw, handlers),
    })
    // No unconditional report here: the source announces its state at
    // subscribe time and on every change, so anything added on top would
    // either overwrite an accurate "not connected yet" or double-report a
    // connection — and the session sends client_ready per report.
  }

  /**
   * The keeper's state, read once the stream carries the workspace. Through
   * the source, not a direct fetch, for the same reason push is: which
   * authority answers is the implementations' difference. The hub asks the
   * daemon; the worker-backed source asks the worker's replica, so a second
   * tab opens without a daemon round trip and off this thread.
   *
   * The connection is reported after it, so a caller is never told it is
   * connected over a copy it does not have yet.
   */
  private async open(handlers: DocumentBackendHandlers, opening: FrameHold): Promise<void> {
    const connection = this.connection
    // `null` is "the authority does not know this document" — the caller
    // keeps its own state and the stream fills in from empty, the same path
    // a first-ever open takes. A failed read is not terminal either: the
    // caller keeps whatever document state it already had.
    await this.fetchKeeperState(
      handlers,
      (bytes) => {
        if (bytes.byteLength > 0) handlers.onSnapshot(bytes)
      },
      opening,
    )
    if (this.cancelled || this.connection !== connection) return
    this.opened = true
    if (this.routed) handlers.onConnected()
  }

  /** What the workspace key's subscription does with each thing the source says. */
  private binaryListener(handlers: DocumentBackendHandlers, opening: FrameHold): DocListener {
    const routing = routingTransitions({
      first: () => void this.open(handlers, opening),
      resumed: () => void this.catchUp(handlers),
    })
    return {
      onUpdate: (bytes) => {
        if (this.hold !== null) this.hold.frames.push(bytes)
        else handlers.onRemoteUpdate(bytes)
      },
      // Nothing addresses text to the workspace key; per-document text
      // arrives on the per-document subscription `run` makes.
      onMessage: () => {},
      // The stream belongs to the source, so its liveness is the only signal
      // this backend has that updates are still arriving.
      onConnectionChange: (connected) => {
        if (this.cancelled) return
        this.routed = connected
        routing(connected)
        if (!connected) handlers.onDisconnected?.()
        else if (this.opened) handlers.onConnected()
      },
      // A worker-backed source's push returns before the keeper answers, so
      // this is the only word this page gets that a write failed — and, since
      // the worker retries on its own, that the failure is over.
      onWriteState: (landed) => {
        if (this.cancelled) return
        this.sourceWritesFailing = !landed
        if (landed) {
          this.settleSourceLandings(null)
          handlers.onWritesLanded?.()
        } else handlers.onError?.('storage-failure')
      },
      // A refused credential is the caller's to surface, not this backend's
      // to retry: the source has already stopped reconnecting.
      onAuthRefused: () => {
        if (this.cancelled) return
        handlers.onAuthError?.()
      },
      onWriteRefused: (refusal) => this.writeRefused(refusal, handlers),
    }
  }

  /**
   * The keeper refused bytes it will refuse every time, and every edit after
   * them is built on them: the caller is told why, then handed the keeper's
   * state to continue from.
   */
  private writeRefused(refusal: SyncWriteRefusal, handlers: DocumentBackendHandlers): void {
    if (this.cancelled) return
    // What was outstanding is dropped with the copy that held it, and the
    // caller answers the refusal by taking the keeper's state.
    this.sourceWritesFailing = false
    this.settleSourceLandings(null)
    handlers.onWriteRefused?.(refusal)
    void this.resync(handlers)
  }

  private resync(handlers: DocumentBackendHandlers): Promise<void> {
    // Through `onSnapshot`: the caller drops its copy, which holds the
    // refused ops, for the keeper's.
    return this.fetchKeeperState(handlers, (bytes) => handlers.onSnapshot(bytes))
  }

  /**
   * The stream carries only what is written while it is open, so whatever the
   * keeper took during the gap reaches no frame — and every later frame
   * builds on it, so a CRDT would hold each one back for history that never
   * comes. The keeper's state is merged in as an update: the caller's own
   * edits are intact, and an import of what it already has changes nothing.
   */
  private catchUp(handlers: DocumentBackendHandlers): Promise<void> {
    return this.fetchKeeperState(handlers, (bytes) => {
      if (bytes.byteLength > 0) handlers.onRemoteUpdate(bytes)
    })
  }

  /** Start holding frames for a read of the keeper's state, sharing a hold already running. */
  private holdFrames(): FrameHold {
    this.hold ??= { frames: [], reads: 0 }
    this.hold.reads += 1
    return this.hold
  }

  private async fetchKeeperState(
    handlers: DocumentBackendHandlers,
    deliver: (bytes: Uint8Array) => void,
    hold: FrameHold = this.holdFrames(),
  ): Promise<void> {
    try {
      const bytes = await this.resolveSource().snapshot(this.binaryKey)
      if (this.hold === hold && bytes !== null) deliver(bytes)
    } catch {
      // The caller keeps the copy it has. After a refusal its next write is
      // refused again and asks again; after a reconnect the next drop does.
    } finally {
      hold.reads -= 1
      if (hold.reads === 0 && this.hold === hold) {
        this.hold = null
        for (const bytes of hold.frames) handlers.onRemoteUpdate(bytes)
      }
    }
  }

  /**
   * The stream this backend talks through. An injected source is shared —
   * the SharedWorker-backed one across tabs, or a page's own hub — and owned
   * by whoever injected it; otherwise this backend owns a hub of its own and
   * is responsible for closing it.
   */
  private resolveSource(): SseStreamSource {
    if (this.streamSource) return this.streamSource
    this.ownedHub ??= new SseStreamHub({ fetch: this.fetchFn, baseUrl: this.baseUrl })
    return this.ownedHub
  }

  private dispatchText(raw: string, handlers: DocumentBackendHandlers): void {
    // The parser is the one definition of a text frame, so a frame whose type
    // it does not know is dropped there; this switch is exhaustive so a type
    // it does know cannot arrive here without a handler.
    const message = parseServerTextMessage(raw)
    if (message === null) return
    switch (message.type) {
      case 'version_created':
        handlers.onVersionCreated(message.version)
        return
      case 'restore_started':
        handlers.onRestoreStarted(message)
        return
      case 'restore_complete':
        handlers.onRestoreComplete()
        return
      case 'viewport_request':
        handlers.onViewportRequest(message)
        return
      case 'agent_activity':
        handlers.onAgentActivity?.(message)
        return
      default:
        message satisfies never
    }
  }

  disconnect(): void {
    this.cancelled = true
    this.connection += 1
    this.handlers = null
    this.hold = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribeText?.()
    this.unsubscribeText = null
    // Closing the writer stops it taking more, not sending what it took
    // (the port's `disconnect` rule). It drains through the source it was
    // built over, and a closed hub still answers `push`: a POST depends on
    // nothing the close below tears down.
    this.writer?.close()
    this.writer = null
    this.sourceWritesFailing = false
    this.settleSourceLandings(new Error('backend disconnected'))
    // Only a hub this backend created is closed here — a shared one outlives
    // any single canvas and is owned by whoever injected it.
    this.ownedHub?.close()
    this.ownedHub = null
  }

  pushLocalUpdate(bytes: Uint8Array): void | Promise<void> {
    // A backend that holds a writer is the only keeper of what it sends, and
    // keeps sending it until the daemon has taken it.
    if (this.writer !== null) return this.writer.write(bytes)
    const handlers = this.handlers
    if (this.streamSource === undefined) {
      if (handlers === null) return
      this.writer = this.ownWriter(handlers)
      return this.writer.write(bytes)
    }
    // Through the injected source, not straight to the daemon, because the
    // source is what knows where this document's authority lives. With a
    // SharedWorker, the worker's replica merges the bytes against everything
    // else it has seen and writes onward itself — retrying as it goes — so
    // posting here would write around that replica and re-send state the
    // daemon had just delivered.
    //
    // Who retries follows from what the push answers, per `SseStreamSource`'s
    // contract — not from who built the source, since a page may share a hub
    // as readily as a worker.
    const pushed = this.streamSource.push(this.binaryKey, bytes)
    if (pushed === undefined) return this.landingOfSourceWrites()
    if (handlers === null) return pushed
    // A promise says the source keeps no copy: from here this backend is the
    // only thing that will ever send this write again, so it keeps it until
    // the daemon has taken it — the same guarantee the worker gives, from the
    // same `WriteChain`. The attempt already running is the writer's first.
    this.writer = this.ownWriter(handlers, pushed)
    return this.writer.write(bytes)
  }

  /**
   * A source that writes onward itself reports only the first failure of a
   * run, so a write handed over while one is failing has landed nothing: it
   * settles when the source says everything landed. Settling at hand-over
   * would read as saved over a retry that is still failing.
   */
  private landingOfSourceWrites(): Promise<void> | undefined {
    if (!this.sourceWritesFailing) return undefined
    return new Promise<void>((landed, dropped) => {
      this.sourceLandings.push({ landed, dropped })
    })
  }

  private settleSourceLandings(dropped: Error | null): void {
    for (const waiter of this.sourceLandings.splice(0)) {
      if (dropped === null) waiter.landed()
      else waiter.dropped(dropped)
    }
  }

  private ownWriter(handlers: DocumentBackendHandlers, running?: Promise<void>): QueuedWriter {
    let first = running
    // Resolved once: a writer still draining after `disconnect()` keeps
    // posting through the hub it started on, rather than minting a new one on
    // a backend nothing will close again.
    const source = this.resolveSource()
    return new QueuedWriter(
      (bytes) => {
        const attempt = first ?? source.push(this.binaryKey, bytes) ?? Promise.resolve()
        first = undefined
        return attempt
      },
      {
        onFailing: () => {
          if (!this.cancelled) handlers.onError?.('storage-failure')
        },
        onLanded: () => {
          if (!this.cancelled) handlers.onWritesLanded?.()
        },
        onRefused: (refusal) => this.writeRefused(refusal, handlers),
      },
    )
  }

  sendClientReady(): void {
    this.resolveSource().sendMessage(this.docKey, { type: 'client_ready' })
  }
}
