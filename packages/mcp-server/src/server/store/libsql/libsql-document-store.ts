import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocumentStore,
  Frontier,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
  SnapshotChunk,
} from '@kamiazya/whiteboard-canvas-ports'
import type { Kysely, Transaction } from 'kysely'
import { getLogger } from '../../log.js'
import type { DatabaseSchema } from '../db/schema.js'
import { docRefKey } from '../doc-ref-key.js'
import { cloneBytes } from '../inmemory/clone-bytes.js'

const log = getLogger('libsql-document-store')

// The libsql/better-sqlite3-shaped drivers behind Kysely's two dialects
// return BLOB columns as `Buffer` (Node SqliteDialect) or `Uint8Array`
// (LibsqlDialect) depending on which one is wired up. `cloneBytes` copies
// either into a fresh `ArrayBuffer`-backed `Uint8Array` so callers never
// share memory with a driver-owned buffer.
function normalizeBlob(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return cloneBytes(value)
}

// `Buffer.from(uint8Array)` treats a TypedArray as an array-like of byte
// values and always copies into a fresh Buffer — this is what keeps a
// caller's later mutation of its own input array from corrupting the row we
// are about to write.
function toBlob(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes)
}

type Db = Kysely<DatabaseSchema>
type Trx = Transaction<DatabaseSchema>

async function upsertFrontier(trx: Trx, docKey: string, frontier: Frontier): Promise<void> {
  const blob = toBlob(frontier)
  await trx
    .insertInto('canvasDocFrontiers')
    .values({ docKey, frontier: blob })
    .onConflict((oc) => oc.column('docKey').doUpdateSet({ frontier: blob }))
    .execute()
}

/**
 * libSQL-backed `DocumentStore`. Snapshot replace (saveSnapshot) and delta
 * append (appendDeltas) each run inside a single Kysely transaction so a
 * mid-write failure never leaves a header without chunks, a stale chunk
 * mixed with a new set, or a gap/duplicate in per-docKey delta `seq`.
 */
export class LibsqlDocumentStore implements DocumentStore {
  constructor(private readonly db: Db) {}

  /**
   * The returned `frontier` is the doc's *current* frontier (from
   * canvasDocFrontiers) rather than the frontier the snapshot itself was
   * saved with — this mirrors InMemoryDocumentStore, whose single per-doc
   * `frontier` field is shared and overwritten by both saveSnapshot and
   * appendDeltas, so a later appendDeltas call also changes what a
   * subsequent loadSnapshot reports.
   */
  async loadSnapshot({ docRef }: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const docKey = docRefKey(docRef)
    const header = await this.db
      .selectFrom('canvasDocSnapshots')
      .select(['chunkCount', 'totalBytes', 'maxChunkBytes'])
      .where('docKey', '=', docKey)
      .executeTakeFirst()
    if (!header) {
      return null
    }

    const [chunkRows, frontier] = await Promise.all([
      this.db
        .selectFrom('canvasDocSnapshotChunks')
        .select(['chunkIndex', 'bytes'])
        .where('docKey', '=', docKey)
        .orderBy('chunkIndex', 'asc')
        .execute(),
      this.currentFrontier(docKey),
    ])

    const chunks: SnapshotChunk[] = chunkRows.map((row) => ({
      index: row.chunkIndex,
      of: header.chunkCount,
      bytes: normalizeBlob(row.bytes),
    }))

    return {
      manifest: {
        chunkCount: header.chunkCount,
        totalBytes: header.totalBytes,
        maxChunkBytes: header.maxChunkBytes,
      },
      chunks,
      frontier,
    }
  }

  // Current "latest write wins" frontier for a doc, or an empty frontier when
  // the doc has never been written. loadSnapshot/loadDeltas report this rather
  // than a per-log frontier — see their doc comments for why.
  private async currentFrontier(docKey: string): Promise<Frontier> {
    const row = await this.db
      .selectFrom('canvasDocFrontiers')
      .select('frontier')
      .where('docKey', '=', docKey)
      .executeTakeFirst()
    return row ? normalizeBlob(row.frontier) : new Uint8Array()
  }

  async saveSnapshot({ docRef, manifest, chunks, frontier }: SaveSnapshotInput): Promise<void> {
    const docKey = docRefKey(docRef)
    const frontierBlob = toBlob(frontier)

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('canvasDocSnapshots')
        .values({
          docKey,
          chunkCount: manifest.chunkCount,
          totalBytes: manifest.totalBytes,
          maxChunkBytes: manifest.maxChunkBytes,
          frontier: frontierBlob,
        })
        .onConflict((oc) =>
          oc.column('docKey').doUpdateSet({
            chunkCount: manifest.chunkCount,
            totalBytes: manifest.totalBytes,
            maxChunkBytes: manifest.maxChunkBytes,
            frontier: frontierBlob,
          }),
        )
        .execute()

      await trx.deleteFrom('canvasDocSnapshotChunks').where('docKey', '=', docKey).execute()

      if (chunks.length > 0) {
        await trx
          .insertInto('canvasDocSnapshotChunks')
          .values(
            chunks.map((chunk) => ({
              docKey,
              chunkIndex: chunk.index,
              bytes: toBlob(chunk.bytes),
            })),
          )
          .execute()
      }

      await upsertFrontier(trx, docKey, frontier)
    })

    log.debug({ docKey, chunkCount: manifest.chunkCount }, 'saved snapshot')
  }

  async deleteDoc({ docRef }: DeleteDocInput): Promise<void> {
    const docKey = docRefKey(docRef)
    // All four tables in one transaction. A partial delete would leave a
    // frontier or a delta run addressing a snapshot that is gone, which
    // loadSnapshot cannot distinguish from a document mid-write.
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('canvasDocSnapshotChunks').where('docKey', '=', docKey).execute()
      await trx.deleteFrom('canvasDocSnapshots').where('docKey', '=', docKey).execute()
      await trx.deleteFrom('canvasDocDeltas').where('docKey', '=', docKey).execute()
      await trx.deleteFrom('canvasDocFrontiers').where('docKey', '=', docKey).execute()
    })
    log.debug({ docKey }, 'deleted doc')
  }

  async appendDeltas({ docRef, deltaBatch }: AppendDeltasInput): Promise<AppendDeltasResult> {
    const docKey = docRefKey(docRef)
    const newFrontier = cloneBytes(deltaBatch.newFrontier)
    const frontierBlob = toBlob(newFrontier)

    await this.db.transaction().execute(async (trx) => {
      const maxRow = await trx
        .selectFrom('canvasDocDeltas')
        .select((eb) => eb.fn.max('seq').as('maxSeq'))
        .where('docKey', '=', docKey)
        .executeTakeFirst()
      let nextSeq = (maxRow?.maxSeq ?? 0) + 1

      const rows = deltaBatch.updates.map((update) => ({
        docKey,
        seq: nextSeq++,
        bytes: toBlob(update),
        frontier: frontierBlob,
      }))
      await trx.insertInto('canvasDocDeltas').values(rows).execute()

      await upsertFrontier(trx, docKey, newFrontier)
    })

    log.debug({ docKey, count: deltaBatch.updates.length }, 'appended deltas')
    return { frontier: cloneBytes(newFrontier) }
  }

  /**
   * `sinceFrontier` is intentionally ignored, matching `InMemoryDocumentStore`
   * — comparing frontiers is a loro-crdt runtime concern that this DocRef-keyed
   * SQL store has no access to. It always returns the full append-ordered
   * delta log, a superset of "everything since `sinceFrontier`" for every
   * caller.
   *
   * The returned `frontier` is the doc's *current* frontier (from
   * canvasDocFrontiers), not the frontier of the last delta row — a
   * saveSnapshot that runs after the last appendDeltas call still advances
   * what this method reports, matching InMemoryDocumentStore's single
   * per-doc `frontier` field that both write paths update.
   */
  async loadDeltas({ docRef }: LoadDeltasInput): Promise<LoadDeltasResult> {
    const docKey = docRefKey(docRef)
    const [rows, frontier] = await Promise.all([
      this.db
        .selectFrom('canvasDocDeltas')
        .select('bytes')
        .where('docKey', '=', docKey)
        .orderBy('seq', 'asc')
        .execute(),
      this.currentFrontier(docKey),
    ])

    return {
      updates: rows.map((row) => normalizeBlob(row.bytes)),
      frontier,
    }
  }

  async readFrontier({ docRef }: ReadFrontierInput): Promise<ReadFrontierResult> {
    const docKey = docRefKey(docRef)
    const row = await this.db
      .selectFrom('canvasDocFrontiers')
      .select('frontier')
      .where('docKey', '=', docKey)
      .executeTakeFirst()
    if (!row) {
      return null
    }
    return { frontier: normalizeBlob(row.frontier) }
  }
}
