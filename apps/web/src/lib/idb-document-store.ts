/**
 * `DocumentStore` over IndexedDB — the browser's twin of the daemon's
 * `LibsqlDocumentStore`, held to the same conformance suite.
 *
 * The daemon spreads one document's sync state across four tables
 * (`documentSnapshots`, `documentSnapshotChunks`, `documentFrontiers`,
 * `documentDeltas`) because a ROW is the unit there, and buys the port's
 * atomicity with a SQL transaction across them. Here it is two stores — the
 * manifest, frontier and delta log in one record per document, the snapshot's
 * BYTES in a store of their own keyed by `[docRefKey, chunkIndex]` — and one
 * `readwrite` transaction across both gives the same guarantee without a join.
 *
 * The split is not about size, it is about what a read costs. IndexedDB has no
 * partial `get`: a record comes back whole. With the chunks inline, appending
 * one 88-byte delta had to deserialize the entire snapshot first, so the price
 * of an edit grew with the document. Everything the daemon needs care about
 * across four tables is still free here — replacing a snapshot cannot orphan a
 * chunk and `deleteDoc` cannot half-succeed — because both stores are written
 * in the one transaction, and a chunk is addressed by the key of the record
 * that describes it.
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
  DocRef,
  DocumentStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveCompactedSnapshotInput,
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-ports'
import { docRefKey, StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { SYNC_DOCUMENTS_STORE, SYNC_SNAPSHOT_CHUNKS_STORE } from './browser-idb.js'
import { inTransaction, request, storedBytesSchema } from './idb-tx.js'

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
const chunkSchema = z.object({
  index: z.number().int().min(0),
  of: z.number().int().min(1),
  bytes: storedBytesSchema,
})

/** One document's chunks, as they come back out of their store. */
const chunksSchema = z.array(chunkSchema)

const syncRecordSchema = z
  .object({
    v: z.literal(2),
    snapshot: z
      .object({
        manifest: z.object({
          chunkCount: z.number().int().min(0),
          totalBytes: z.number().int().min(0),
          maxChunkBytes: z.number().int().positive(),
        }),
      })
      .strict()
      .nullable(),
    frontier: storedBytesSchema.nullable(),
    deltas: z.array(storedBytesSchema),
  })
  .strict()
  // One direction only. A SNAPSHOT with no frontier is a record
  // `loadSnapshot` can answer nothing but `null` for — indistinguishable from
  // a document that was never saved, which is the distinction this store
  // exists to keep. The reverse is ordinary: `appendDeltas` on a document
  // with no snapshot yet is explicitly legal, and leaves a frontier and a log
  // with nothing to anchor them.
  .refine((record) => record.snapshot === null || record.frontier !== null, {
    message: 'a stored snapshot must carry the frontier it was saved with',
  })

type SyncRecord = z.infer<typeof syncRecordSchema>

const EMPTY_RECORD: SyncRecord = { v: 2, snapshot: null, frontier: null, deltas: [] }

/**
 * Every chunk of one document, as a key range.
 *
 * The upper bound is an EMPTY ARRAY rather than a large number, because
 * IndexedDB orders keys by type before value and an array sorts after every
 * number — so `[key, []]` is the first key past this document's chunks
 * whatever index they carry, and no magic ceiling can be exceeded.
 */
function chunkRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key], [key, []])
}

/**
 * A stored record, or a refusal that says WHY.
 *
 * The two failures are opposite messages to a user: a record from a newer
 * envelope means their build is old, and one that parses as nothing means
 * their document is damaged. Answering `null` for either would say "you have
 * no such document" about data that is sitting right there — which is the
 * whole reason the port names this failure instead of folding it into the
 * absent case.
 *
 * This store can report both codes because its records ARE versioned
 * envelopes. The daemon's cannot: its records are typed columns, with no
 * envelope version to be wrong about.
 */
function parseRecord(key: string, raw: unknown): SyncRecord {
  const parsed = syncRecordSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const version = (raw as { v?: unknown } | null)?.v
  if (typeof version === 'number' && version !== 2) {
    throw new StoredDocumentUnreadableError(
      'unsupported-version',
      `Stored document ${key} was written in envelope version ${version}`,
    )
  }
  throw new StoredDocumentUnreadableError('malformed', `Stored document ${key} does not parse`)
}

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

/** Replaces every chunk of `key` with `chunks`, in the caller's transaction. */
async function writeChunks(
  tx: IDBTransaction,
  key: string,
  chunks: readonly { index: number; of: number; bytes: Uint8Array }[],
): Promise<void> {
  const store = tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE)
  // Ranged, not per-index: the snapshot being replaced may have had MORE
  // chunks than the one replacing it, and a put-only write would leave that
  // tail behind for the next read to find and refuse.
  await request(store.delete(chunkRange(key)))
  for (const chunk of chunks) {
    await request(store.put({ ...chunk, bytes: copy(chunk.bytes) }, [key, chunk.index]))
  }
}

export class IdbDocumentStore implements DocumentStore {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(private readonly dbName?: string) {}

  /**
   * `stores` is per-call rather than always both, so an operation that does
   * not touch snapshot bytes does not lock the store holding them. The
   * transaction is the unit of atomicity AND of contention here, and every
   * edit goes through `appendDeltas`.
   */
  #read(
    mode: IDBTransactionMode,
    key: string,
    stores: string[],
    body: (record: SyncRecord, tx: IDBTransaction) => Promise<void> | void,
  ) {
    return inTransaction(this.dbName, stores, mode, async (tx) => {
      const raw = await request(tx.objectStore(SYNC_DOCUMENTS_STORE).get(key))
      await body(raw === undefined ? EMPTY_RECORD : parseRecord(key, raw), tx)
    })
  }

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const key = docRefKey(input.docRef)
    let result: LoadSnapshotResult = null
    await this.#read(
      'readonly',
      key,
      [SYNC_DOCUMENTS_STORE, SYNC_SNAPSHOT_CHUNKS_STORE],
      async (record, tx) => {
        if (record.snapshot === null || record.frontier === null) return
        const manifest = record.snapshot.manifest
        // `getAll` over the whole range, not `get` per index: the manifest
        // says how many chunks there should be, and asking for exactly that
        // many would hide a stored chunk it does not account for — which is
        // precisely the disagreement below refuses on.
        const raw = await request(
          tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE).getAll(chunkRange(key)),
        )
        const parsed = chunksSchema.safeParse(raw)
        const chunks = parsed.success ? parsed.data : []
        // The port's own manifest/chunk agreement, checked HERE rather than
        // trusted. A snapshot whose manifest and chunks disagree cannot be
        // served as a `LoadSnapshotResult` — the result schema refines on
        // exactly this — so accepting it would mean answering with a shape
        // the contract says is invalid, or silently answering `null` for data
        // that is present.
        //
        // It moved out of the record schema when the bytes did. While the two
        // were one value the disagreement was unreachable by construction;
        // now they are two, so a write landing one and not the other is a
        // state a read has to name. Same refusal either way: an unreadable
        // document, not a missing one.
        if (
          !parsed.success ||
          chunks.length !== manifest.chunkCount ||
          chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0) !== manifest.totalBytes
        ) {
          throw new StoredDocumentUnreadableError(
            'malformed',
            `Stored document ${key} has chunks that do not match its manifest`,
          )
        }
        result = {
          manifest,
          // Sorted by the index each chunk CARRIES, not by the one in its
          // key. A ranged `getAll` already answers in key order, so this is
          // the same list on every sound store — it differs only where a
          // chunk sits under a key that disagrees with itself, and there the
          // value is what `reassembleSnapshot` will be checking.
          chunks: [...chunks]
            .sort((a, b) => a.index - b.index)
            .map((chunk) => ({ ...chunk, bytes: copy(chunk.bytes) })),
          // The CURRENT frontier, which later deltas may have moved past the
          // one this snapshot was saved with. Answering with the saved one
          // would tell a caller it is caught up when it is not.
          frontier: copy(record.frontier),
        }
      },
    )
    return result
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    const key = docRefKey(input.docRef)
    await this.#read(
      'readwrite',
      key,
      [SYNC_DOCUMENTS_STORE, SYNC_SNAPSHOT_CHUNKS_STORE],
      async (record, tx) => {
        const next: SyncRecord = {
          ...record,
          // Replaced, never merged: a snapshot is the whole state of the
          // document at a point, so the previous chunks have to go with it.
          snapshot: { manifest: input.manifest },
          frontier: copy(input.frontier),
        }
        await request(tx.objectStore(SYNC_DOCUMENTS_STORE).put(next, key))
        await writeChunks(tx, key, input.chunks)
      },
    )
  }

  async appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult> {
    const key = docRefKey(input.docRef)
    const frontier = copy(input.deltaBatch.newFrontier)
    // The snapshot store is deliberately OUT of scope. Nothing here reads or
    // writes a chunk, and naming the store would both lock it and re-open the
    // cost this split exists to remove.
    await this.#read('readwrite', key, [SYNC_DOCUMENTS_STORE], async (record, tx) => {
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
    await this.#read('readonly', docRefKey(input.docRef), [SYNC_DOCUMENTS_STORE], (record) => {
      result = {
        updates: record.deltas.map(copy),
        frontier: record.frontier === null ? new Uint8Array() : copy(record.frontier),
      }
    })
    return result
  }

  async readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult> {
    let result: ReadFrontierResult = null
    await this.#read('readonly', docRefKey(input.docRef), [SYNC_DOCUMENTS_STORE], (record) => {
      if (record.frontier === null) return
      result = { frontier: copy(record.frontier) }
    })
    return result
  }

  /**
   * One transaction, so a concurrent `appendDeltas` cannot land between the
   * save and the clear and be silently dropped. That window is the whole
   * reason this is an operation rather than two calls at the call site.
   */
  async saveCompactedSnapshot(input: SaveCompactedSnapshotInput): Promise<void> {
    const key = docRefKey(input.docRef)
    await this.#read(
      'readwrite',
      key,
      [SYNC_DOCUMENTS_STORE, SYNC_SNAPSHOT_CHUNKS_STORE],
      async (record, tx) => {
        const next: SyncRecord = {
          v: 2,
          snapshot: { manifest: input.manifest },
          frontier: copy(input.frontier),
          // The half `saveSnapshot` does not do — but only the SUPERSEDED
          // prefix. Anything appended after the caller folded is not in the
          // snapshot, so clearing the whole log would lose it.
          deltas: record.deltas.slice(input.supersededDeltaCount),
        }
        await request(tx.objectStore(SYNC_DOCUMENTS_STORE).put(next, key))
        await writeChunks(tx, key, input.chunks)
      },
    )
  }

  /**
   * Put a record this store cannot read under `docRef`. Test-only, and named
   * so at the call site: the port's conformance suite needs every
   * implementation to be able to reach the unreadable state.
   */
  async writeUnreadableRecord(docRef: DocRef): Promise<void> {
    await inTransaction(this.dbName, [SYNC_DOCUMENTS_STORE], 'readwrite', async (tx) => {
      await request(
        tx.objectStore(SYNC_DOCUMENTS_STORE).put({ v: 99, nonsense: true }, docRefKey(docRef)),
      )
    })
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    const key = docRefKey(input.docRef)
    await inTransaction(
      this.dbName,
      [SYNC_DOCUMENTS_STORE, SYNC_SNAPSHOT_CHUNKS_STORE],
      'readwrite',
      async (tx) => {
        // Two stores, one transaction, so there is still no partial delete to
        // guard against — the state the daemon needs a transaction across four
        // tables to remove is two ranged operations here. Deleting a key or a
        // range that holds nothing is already quiet, which is what the port
        // asks.
        await request(tx.objectStore(SYNC_DOCUMENTS_STORE).delete(key))
        await request(tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE).delete(chunkRange(key)))
      },
    )
  }
}
