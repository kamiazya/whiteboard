import { Loro } from 'loro-crdt'
import type { CanvasBackend, CanvasBackendHandlers, BinaryFileDataLike } from '@kamiazya/whiteboard-mcp/browser-contract'
import { LoroStore } from './loro-store.js'

/**
 * BrowserLocalBackend: CanvasBackend implementation for fully offline,
 * browser-local use. Persists Loro CRDT snapshots and incremental deltas
 * in IndexedDB via LoroStore (DB v2 'loroCanvases' store).
 *
 * getFile/putFile: OPFS file storage is deferred to a later slice. Both
 * methods are present to satisfy the CanvasBackend interface; getFile
 * returns null and putFile resolves without calling onFileSuccess.
 *
 * sendClientReady/sendExportResponse: no WebSocket in browser-local mode;
 * both are no-ops.
 *
 * Error signaling: failures route to handlers.onError (optional, defaults
 * to a no-op) with a typed reason string. No unhandled rejections.
 *
 * TOCTOU safety: all writes are serialized through a per-instance promise
 * chain (_writeQueue) so concurrent pushLocalUpdate calls cannot interleave
 * the read-then-write logic at the BrowserLocalBackend level. LoroStore
 * further serializes the read-modify-write inside a single IDB readwrite
 * transaction for appendDelta.
 */
export class BrowserLocalBackend implements CanvasBackend {
  private readonly canvasId: string
  private readonly store: LoroStore
  private handlers: CanvasBackendHandlers | null = null
  private disconnected = false
  /** Serializes all write operations (pushLocalUpdate) to prevent TOCTOU races. */
  private _writeQueue: Promise<void> = Promise.resolve()

  constructor(canvasId: string, store?: LoroStore) {
    this.canvasId = canvasId
    this.store = store ?? new LoroStore()
  }

  connect(handlers: CanvasBackendHandlers): void {
    this.disconnected = false
    this.handlers = handlers
    // Fire synchronously so the caller can observe onConnected immediately.
    handlers.onConnected()
    this.loadAndDeliver().catch(() => {
      if (this.disconnected || this.handlers !== handlers) return
      handlers.onError?.('storage-failure')
    })
  }

  disconnect(): void {
    this.disconnected = true
    this.handlers = null
  }

  /**
   * Accept a local Loro update. The first call after connect() is treated
   * as the canonical snapshot (full export); subsequent calls are deltas.
   * Both are persisted so a reload can replay snapshot then deltas in order.
   *
   * Writes are chained onto _writeQueue so two concurrent calls apply in
   * order with no lost update.
   */
  pushLocalUpdate(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return Promise.resolve()
    this._writeQueue = this._writeQueue.then(() => this._doWrite(bytes))
    return this._writeQueue
  }

  private async _doWrite(bytes: Uint8Array): Promise<void> {
    try {
      const existing = await this.store.load(this.canvasId)
      if (existing.kind === 'not-found') {
        // First write: save as snapshot.
        await this.store.save(this.canvasId, bytes)
      } else if (existing.kind === 'ok') {
        // Subsequent writes: append as delta.
        await this.store.appendDelta(this.canvasId, bytes)
      } else {
        // Existing record is corrupt or version-mismatch; appending would
        // silently discard the delta. Surface the failure.
        this.handlers?.onError?.('storage-failure')
      }
    } catch {
      this.handlers?.onError?.('storage-failure')
    }
  }

  /**
   * OPFS file storage is deferred. Returns null for every fileId.
   */
  async getFile(_fileId: string): Promise<Blob | null> {
    return null
  }

  /**
   * OPFS file storage is deferred. Resolves without calling onFileSuccess.
   */
  async putFile(
    _newEntries: [string, BinaryFileDataLike][],
    _onFileSuccess: (fileId: string) => void,
  ): Promise<void> {
    // Intentionally a no-op: OPFS upload is not implemented in 3-C.
  }

  /** No WebSocket in browser-local mode. */
  sendClientReady(): void { /* no-op */ }

  /** No WebSocket in browser-local mode. */
  sendExportResponse(_requestId: string, _data: string): void { /* no-op */ }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** True once the original connect() handlers are no longer the live ones. */
  private isStale(handlers: CanvasBackendHandlers): boolean {
    return this.disconnected || this.handlers !== handlers
  }

  private async loadAndDeliver(): Promise<void> {
    const handlers = this.handlers
    if (!handlers) return

    let result
    try {
      result = await this.store.load(this.canvasId)
    } catch {
      if (this.isStale(handlers)) return
      handlers.onError?.('storage-failure')
      return
    }

    if (this.isStale(handlers)) return

    if (result.kind === 'not-found') {
      // No persisted data: deliver an empty snapshot so the hook can initialise.
      const emptyDoc = new Loro()
      handlers.onSnapshot(emptyDoc.export({ mode: 'snapshot' }))
      return
    }

    if (result.kind === 'corrupt-snapshot') {
      handlers.onError?.('corrupt-snapshot')
      return
    }

    if (result.kind === 'corrupt-delta') {
      handlers.onError?.('corrupt-delta')
      return
    }

    if (result.kind === 'unsupported-version') {
      handlers.onError?.('unsupported-version')
      return
    }

    // Deliver the persisted snapshot. Bytes were deep-validated in LoroStore.load()
    // so doc.import() in the hook will not throw for valid records.
    handlers.onSnapshot(result.snapshot)

    // Replay incremental deltas as onRemoteUpdate. Each delta was deep-validated
    // in LoroStore.load() so the hook's doc.import() will not throw.
    for (const delta of result.deltas ?? []) {
      if (this.disconnected || this.handlers !== handlers) return
      handlers.onRemoteUpdate(delta)
    }
  }
}
