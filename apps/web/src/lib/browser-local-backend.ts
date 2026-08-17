import type {
  BinaryFileDataLike,
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { Loro } from 'loro-crdt'
import { DocumentFileStore, dataUrlToBlob } from './document-file-store.js'
import { LoroStore } from './loro-store.js'

/**
 * BrowserLocalBackend: CanvasBackend implementation for fully offline,
 * browser-local use. Persists Loro CRDT snapshots and incremental deltas
 * in IndexedDB via LoroStore (DB v2 'loroDocuments' store), and uploaded
 * image files via DocumentFileStore (DB v4 'documentFiles' store).
 *
 * getFile/putFile: images are persisted to IndexedDB (not OPFS — see the
 * class-level design note in document-file-store.ts for the rationale).
 * putFile stores each entry keyed by its tuple fileId (never
 * BinaryFileDataLike.id, which callers must not rely on for keying) and
 * calls onFileSuccess once per successfully stored entry; it rejects on a
 * storage failure so the caller never observes a false "success". getFile
 * returns null (without signaling onError) for both unknown ids and
 * corrupt/unknown-version records, so a damaged store degrades to a missing
 * image instead of spamming onError on every render.
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
  private readonly documentId: string
  private readonly store: LoroStore
  private readonly fileStore: DocumentFileStore
  private handlers: CanvasBackendHandlers | null = null
  private disconnected = false
  /** Serializes all write operations (pushLocalUpdate) to prevent TOCTOU races. */
  private _writeQueue: Promise<void> = Promise.resolve()

  constructor(documentId: string, store?: LoroStore, fileStore?: DocumentFileStore) {
    this.documentId = documentId
    this.store = store ?? new LoroStore()
    this.fileStore = fileStore ?? new DocumentFileStore()
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
      const existing = await this.store.load(this.documentId)
      if (existing.kind === 'not-found') {
        // First write: save as snapshot.
        await this.store.save(this.documentId, bytes)
      } else if (existing.kind === 'ok') {
        // Subsequent writes: append as delta.
        await this.store.appendDelta(this.documentId, bytes)
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
   * Returns the persisted Blob for fileId, or null for an unknown id and for
   * a corrupt/unknown-version record — never calls onError, since a read-path
   * miss is not a storage failure (see DocumentFileStore.get).
   */
  async getFile(fileId: string): Promise<Blob | null> {
    return this.fileStore.get(fileId)
  }

  /**
   * Persists each entry keyed by its tuple fileId (the dedupe key
   * useDocumentSync already uses — never `data.id`, which a caller's
   * BinaryFileDataLike is not guaranteed to agree with). Calls
   * onFileSuccess once per successfully stored entry. Rejects and routes
   * handlers.onError?.('storage-failure') on any store failure so a failed
   * upload is never observed as a silent success.
   */
  async putFile(
    newEntries: [string, BinaryFileDataLike][],
    onFileSuccess: (fileId: string) => void,
  ): Promise<void> {
    if (newEntries.length === 0) return

    try {
      for (const [fileId, data] of newEntries) {
        const blob = dataUrlToBlob(data.dataURL, data.mimeType)
        await this.fileStore.put(fileId, {
          mimeType: blob.type,
          blob,
          created: data.created,
        })
        onFileSuccess(fileId)
      }
    } catch (err) {
      this.handlers?.onError?.('storage-failure')
      throw err
    }
  }

  /** No WebSocket in browser-local mode. */
  sendClientReady(): void {
    /* no-op */
  }

  /** No WebSocket in browser-local mode. */
  sendExportResponse(_requestId: string, _data: string): void {
    /* no-op */
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** True once the original connect() handlers are no longer the live ones. */
  private isStale(handlers: CanvasBackendHandlers): boolean {
    return this.disconnected || this.handlers !== handlers
  }

  private async loadAndDeliver(): Promise<void> {
    const handlers = this.handlers
    if (!handlers) return

    let result: Awaited<ReturnType<LoroStore['load']>>
    try {
      result = await this.store.load(this.documentId)
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
