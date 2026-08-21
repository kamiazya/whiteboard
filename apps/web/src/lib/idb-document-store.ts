/**
 * `DocumentStore` over IndexedDB — the browser's twin of the daemon's
 * `LibsqlDocumentStore`, held to the same conformance suite.
 *
 * The daemon spreads one document's sync state across four tables
 * (`documentSnapshots`, `documentSnapshotChunks`, `documentFrontiers`,
 * `documentDeltas`) because a ROW is the unit there, and buys the port's
 * atomicity with a SQL transaction across them. Here a RECORD is the unit, so
 * all four live in one value under one key and a single `readwrite`
 * transaction gives the same guarantee without a join — including the two
 * places the daemon has to be careful about and this does not: replacing a
 * snapshot cannot orphan a chunk, and `deleteDoc` cannot half-succeed.
 *
 * The chunk list is stored as given rather than re-derived, because chunking
 * is the CALLER's: `maxChunkBytes` comes in on the manifest and ports
 * deliberately hardcodes no implementation's cap. Storing it is not optional —
 * `reassembleSnapshot` validates against it, so a read cannot invent one.
 */

import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocumentStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-ports'
import { docRefKey } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { SYNC_DOCUMENTS_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'

/**
 * A document's whole sync state, as stored.
 *
 * `v` is the envelope version: a record written by a shape this build does not
 * know reads as ABSENT rather than throwing, matching how every other store
 * here treats an envelope it cannot parse. For this store that is the right
 * degradation — a document whose sync state cannot be read is a document to
 * re-sync, not a page to take down.
 *
 * `snapshot` is nullable and separate from `deltas` because the two are
 * independently present: `appendDeltas` on a document with no snapshot is
 * legal, and a saved EMPTY snapshot (`chunkCount: 0`) is a document that
 * exists holding no bytes — which the port distinguishes from one never saved.
 */
// `z.custom` rather than `z.instanceof`, for the reason `loro-record-envelope`
// gives: under this package's lib (ES2020 + DOM) `z.instanceof(Uint8Array)`
// infers `Uint8Array<ArrayBufferLike>`, which is wider than the port's DTOs
// and will not assign to them.
const uint8ArraySchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array)

const chunkSchema = z.object({
  index: z.number().int().min(0),
  of: z.number().int().min(1),
  bytes: uint8ArraySchema,
})

const syncRecordSchema = z
  .object({
    v: z.literal(1),
    snapshot: z
      .object({
        manifest: z.object({
          chunkCount: z.number().int().min(0),
          totalBytes: z.number().int().min(0),
          maxChunkBytes: z.number().int().positive(),
        }),
        chunks: z.array(chunkSchema),
      })
      .nullable(),
    frontier: uint8ArraySchema.nullable(),
    deltas: z.array(uint8ArraySchema),
  })
  .strict()

type SyncRecord = z.infer<typeof syncRecordSchema>

const EMPTY_RECORD: SyncRecord = { v: 1, snapshot: null, frontier: null, deltas: [] }

/**
 * A private copy of every byte array crossing the boundary.
 *
 * Narrower than it looks, and measured rather than assumed: removing it leaves
 * the whole conformance suite GREEN, because IndexedDB clones a value during
 * the `put` call itself and hands every `get` its own buffers — so a caller
 * mutating after awaiting can reach neither.
 *
 * What it does close is the window this store opens by reading before it
 * writes: between `saveSnapshot` being CALLED and its internal `get`
 * resolving, the caller's array is still live and still the one that would be
 * stored. A caller who mutates without awaiting is unusual, which is why the
 * suite does not reach it — and why this is a comment rather than a deletion.
 */
// The return type is spelled with its buffer parameter: under this package's
// lib a bare `Uint8Array` means `Uint8Array<ArrayBufferLike>`, which is wider
// than the port's DTOs and does not assign to them. `new Uint8Array(...)`
// already produces the narrow one — only the annotation was throwing it away.
function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

export class IdbDocumentStore implements DocumentStore {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(private readonly dbName?: string) {}

  #read(
    mode: IDBTransactionMode,
    key: string,
    body: (record: SyncRecord, tx: IDBTransaction) => Promise<void> | void,
  ) {
    return inTransaction(this.dbName, [SYNC_DOCUMENTS_STORE], mode, async (tx) => {
      const raw = await request(tx.objectStore(SYNC_DOCUMENTS_STORE).get(key))
      const parsed = raw === undefined ? null : syncRecordSchema.safeParse(raw)
      const record = parsed?.success ? parsed.data : EMPTY_RECORD
      await body(record, tx)
    })
  }

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    let result: LoadSnapshotResult = null
    await this.#read('readonly', docRefKey(input.docRef), (record) => {
      if (record.snapshot === null || record.frontier === null) return
      result = {
        manifest: record.snapshot.manifest,
        // Sorted by index, not by write order. Nothing in the contract says a
        // caller saves chunks in order, and the daemon reads its own back
        // through `order by chunkIndex` — a store that answered in insertion
        // order would make reassembly depend on how it was written.
        chunks: [...record.snapshot.chunks]
          .sort((a, b) => a.index - b.index)
          .map((chunk) => ({ ...chunk, bytes: copy(chunk.bytes) })),
        // The CURRENT frontier, which later deltas may have moved past the
        // one this snapshot was saved with. Answering with the saved one
        // would tell a caller it is caught up when it is not.
        frontier: copy(record.frontier),
      }
    })
    return result
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    const key = docRefKey(input.docRef)
    await this.#read('readwrite', key, async (record, tx) => {
      const next: SyncRecord = {
        ...record,
        // Replaced, never merged: a snapshot is the whole state of the
        // document at a point, so the previous chunk list has to go with it.
        snapshot: {
          manifest: input.manifest,
          chunks: input.chunks.map((chunk) => ({ ...chunk, bytes: copy(chunk.bytes) })),
        },
        frontier: copy(input.frontier),
      }
      await request(tx.objectStore(SYNC_DOCUMENTS_STORE).put(next, key))
    })
  }

  async appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult> {
    const key = docRefKey(input.docRef)
    const frontier = copy(input.deltaBatch.newFrontier)
    await this.#read('readwrite', key, async (record, tx) => {
      const next: SyncRecord = {
        ...record,
        deltas: [...record.deltas, ...input.deltaBatch.updates.map(copy)],
        frontier,
      }
      await request(tx.objectStore(SYNC_DOCUMENTS_STORE).put(next, key))
    })
    return { frontier: copy(frontier) }
  }

  /**
   * `sinceFrontier` is ignored, deliberately and in agreement with every other
   * implementation: comparing frontiers needs the loro-crdt runtime, and a
   * `Frontier` is an opaque `Uint8Array` at this layer. The whole log is a
   * superset of the correct answer for every caller, so a store that later
   * learns to filter stays compatible with all of them.
   */
  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    let result: LoadDeltasResult = { updates: [], frontier: new Uint8Array() }
    await this.#read('readonly', docRefKey(input.docRef), (record) => {
      result = {
        updates: record.deltas.map(copy),
        frontier: record.frontier === null ? new Uint8Array() : copy(record.frontier),
      }
    })
    return result
  }

  async readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult> {
    let result: ReadFrontierResult = null
    await this.#read('readonly', docRefKey(input.docRef), (record) => {
      if (record.frontier === null) return
      result = { frontier: copy(record.frontier) }
    })
    return result
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    await inTransaction(this.dbName, [SYNC_DOCUMENTS_STORE], 'readwrite', async (tx) => {
      // One key holds the snapshot, the frontier and the deltas, so there is
      // no partial delete to guard against — the state the daemon needs a
      // transaction across four tables to remove is one record here. Deleting
      // a key that is not there is already quiet, which is what the port asks.
      await request(tx.objectStore(SYNC_DOCUMENTS_STORE).delete(docRefKey(input.docRef)))
    })
  }
}
