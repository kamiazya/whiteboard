import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocRef,
  DocumentStore,
  Frontier,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  ReadSnapshotManifestInput,
  ReadSnapshotManifestResult,
  SaveCompactedSnapshotInput,
  SaveCompactedSnapshotResult,
  SaveSnapshotInput,
  SnapshotChunk,
} from '@kamiazya/whiteboard-ports'
import { docRefKey, StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { type Kysely, sql, type Transaction } from 'kysely'
import { getLogger } from '../../log.js'
import type { DatabaseSchema } from '../db/schema.js'
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
    .insertInto('documentFrontiers')
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
  async readSnapshotManifest({
    docRef,
  }: ReadSnapshotManifestInput): Promise<ReadSnapshotManifestResult> {
    // The header row IS the manifest here, so this is `loadSnapshot` minus
    // the chunk query — which is the whole point: a caller deciding whether
    // to fold must not pull the snapshot to find out.
    return this.readSnapshotHeader(docRefKey(docRef))
  }

  /**
   * The `documentSnapshots` row as a manifest, or null when there is none.
   *
   * Shared by `loadSnapshot` and `readSnapshotManifest` so the two cannot
   * grow different answers to "is there a snapshot" — a caller uses the
   * cheap one to decide whether to call the expensive one.
   */
  private async readSnapshotHeader(docKey: string): Promise<ReadSnapshotManifestResult> {
    const header = await this.db
      .selectFrom('documentSnapshots')
      .select(['chunkCount', 'totalBytes', 'maxChunkBytes', 'generation'])
      .where('docKey', '=', docKey)
      .executeTakeFirst()
    if (!header) {
      return null
    }
    // A header row that cannot describe a snapshot is a record that is THERE
    // and unreadable, which the port asks to be told apart from absent. This
    // store has no envelope version to be wrong about — its records are typed
    // columns — so `malformed` is the only code it can ever report.
    if (header.maxChunkBytes <= 0 || header.chunkCount < 0 || header.totalBytes < 0) {
      throw new StoredDocumentUnreadableError(
        'malformed',
        `Stored document ${docKey} has a snapshot header that describes no snapshot`,
      )
    }
    return {
      manifest: {
        chunkCount: header.chunkCount,
        totalBytes: header.totalBytes,
        maxChunkBytes: header.maxChunkBytes,
      },
      generation: header.generation,
    }
  }

  async loadSnapshot({ docRef }: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const docKey = docRefKey(docRef)
    const header = await this.readSnapshotHeader(docKey)
    if (header === null) {
      return null
    }
    const { manifest } = header

    const [chunkRows, frontier] = await Promise.all([
      this.db
        .selectFrom('documentSnapshotChunks')
        .select(['chunkIndex', 'bytes'])
        .where('docKey', '=', docKey)
        .orderBy('chunkIndex', 'asc')
        .execute(),
      this.currentFrontier(docKey),
    ])

    const chunks: SnapshotChunk[] = chunkRows.map((row) => ({
      index: row.chunkIndex,
      of: manifest.chunkCount,
      bytes: normalizeBlob(row.bytes),
    }))

    return { manifest, chunks, frontier }
  }

  // Current "latest write wins" frontier for a doc, or an empty frontier when
  // the doc has never been written. loadSnapshot/loadDeltas report this rather
  // than a per-log frontier — see their doc comments for why.
  private async currentFrontier(docKey: string): Promise<Frontier> {
    const row = await this.db
      .selectFrom('documentFrontiers')
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
        .insertInto('documentSnapshots')
        .values({
          docKey,
          chunkCount: manifest.chunkCount,
          totalBytes: manifest.totalBytes,
          maxChunkBytes: manifest.maxChunkBytes,
          frontier: frontierBlob,
          generation: 1,
        })
        .onConflict((oc) =>
          oc.column('docKey').doUpdateSet({
            chunkCount: manifest.chunkCount,
            totalBytes: manifest.totalBytes,
            maxChunkBytes: manifest.maxChunkBytes,
            frontier: frontierBlob,
            // Bare `generation` in a DO UPDATE SET refers to the EXISTING
            // row, so this advances the fence rather than resetting it to the
            // literal above. An authoritative overwrite is unconditional but
            // must still invalidate a fold computed against what it replaced.
            generation: sql<number>`generation + 1`,
          }),
        )
        .execute()

      await trx.deleteFrom('documentSnapshotChunks').where('docKey', '=', docKey).execute()

      if (chunks.length > 0) {
        await trx
          .insertInto('documentSnapshotChunks')
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

  /**
   * One transaction, so a concurrent `appendDeltas` cannot land between the
   * save and the clear and be silently dropped — and so the fence is read and
   * acted on without another writer slipping between the two. SQLite
   * serialises write transactions, which is what makes the read-then-write
   * below a compare-and-swap rather than a check that races.
   */
  async saveCompactedSnapshot(
    input: SaveCompactedSnapshotInput,
  ): Promise<SaveCompactedSnapshotResult> {
    const docKey = docRefKey(input.docRef)
    const frontierBlob = toBlob(input.frontier)
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('documentSnapshots')
        .select('generation')
        .where('docKey', '=', docKey)
        .executeTakeFirst()
      // `null` expects no snapshot; a number expects exactly that generation.
      const current = existing?.generation ?? null
      if (current !== input.expectedGeneration) {
        return { ok: false as const, currentGeneration: current }
      }
      const generation = (current ?? 0) + 1
      await trx
        .insertInto('documentSnapshots')
        .values({
          docKey,
          chunkCount: input.manifest.chunkCount,
          totalBytes: input.manifest.totalBytes,
          maxChunkBytes: input.manifest.maxChunkBytes,
          frontier: frontierBlob,
          generation,
        })
        .onConflict((oc) =>
          oc.column('docKey').doUpdateSet({
            chunkCount: input.manifest.chunkCount,
            totalBytes: input.manifest.totalBytes,
            maxChunkBytes: input.manifest.maxChunkBytes,
            frontier: frontierBlob,
            generation,
          }),
        )
        .execute()
      await trx.deleteFrom('documentSnapshotChunks').where('docKey', '=', docKey).execute()
      if (input.chunks.length > 0) {
        await trx
          .insertInto('documentSnapshotChunks')
          .values(
            input.chunks.map((chunk) => ({
              docKey,
              chunkIndex: chunk.index,
              bytes: toBlob(chunk.bytes),
            })),
          )
          .execute()
      }
      // The half `saveSnapshot` does not do — but only the SUPERSEDED prefix.
      // Everything appended after the caller folded is not in the snapshot,
      // so clearing the whole log would lose it. The transaction makes this
      // and the write above one operation; the count makes it the right one.
      if (input.supersededDeltaCount > 0) {
        await trx
          .deleteFrom('documentDeltas')
          .where('docKey', '=', docKey)
          .where(
            'seq',
            'in',
            trx
              .selectFrom('documentDeltas')
              .select('seq')
              .where('docKey', '=', docKey)
              .orderBy('seq', 'asc')
              .limit(input.supersededDeltaCount),
          )
          .execute()
      }
      await upsertFrontier(trx, docKey, input.frontier)
      log.debug({ docKey, chunkCount: input.manifest.chunkCount }, 'saved compacted snapshot')
      return { ok: true as const, generation }
    })
  }

  /**
   * Write a header row that describes no snapshot. Test-only, and named so at
   * the call site: the port's conformance suite needs every implementation to
   * be able to reach the unreadable state.
   */
  async writeUnreadableRecord(docRef: DocRef): Promise<void> {
    const docKey = docRefKey(docRef)
    await this.db
      .insertInto('documentSnapshots')
      .values({
        docKey,
        chunkCount: 0,
        totalBytes: 0,
        maxChunkBytes: -1,
        frontier: toBlob(new Uint8Array()),
        generation: 1,
      })
      .onConflict((oc) => oc.column('docKey').doUpdateSet({ maxChunkBytes: -1 }))
      .execute()
  }

  async deleteDoc({ docRef }: DeleteDocInput): Promise<void> {
    const docKey = docRefKey(docRef)
    // All four tables in one transaction. A partial delete would leave a
    // frontier or a delta run addressing a snapshot that is gone, which
    // loadSnapshot cannot distinguish from a document mid-write.
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('documentSnapshotChunks').where('docKey', '=', docKey).execute()
      await trx.deleteFrom('documentSnapshots').where('docKey', '=', docKey).execute()
      await trx.deleteFrom('documentDeltas').where('docKey', '=', docKey).execute()
      await trx.deleteFrom('documentFrontiers').where('docKey', '=', docKey).execute()
    })
    log.debug({ docKey }, 'deleted doc')
  }

  async appendDeltas({ docRef, deltaBatch }: AppendDeltasInput): Promise<AppendDeltasResult> {
    const docKey = docRefKey(docRef)
    const newFrontier = cloneBytes(deltaBatch.newFrontier)
    const frontierBlob = toBlob(newFrontier)

    await this.db.transaction().execute(async (trx) => {
      const maxRow = await trx
        .selectFrom('documentDeltas')
        .select((eb) => eb.fn.max('seq').as('maxSeq'))
        .where('docKey', '=', docKey)
        .executeTakeFirst()
      // Assigned from the highest seq PRESENT, so a fold that empties the log
      // lets the next append start over at 1. That is why a tail's cursor is
      // the pair `(generation, afterSeq)` rather than a seq alone — see
      // `loadDeltasResultSchema`.
      let nextSeq = (maxRow?.maxSeq ?? 0) + 1

      const rows = deltaBatch.updates.map((update) => ({
        docKey,
        seq: nextSeq++,
        bytes: toBlob(update),
        frontier: frontierBlob,
      }))
      await trx.insertInto('documentDeltas').values(rows).execute()

      await upsertFrontier(trx, docKey, newFrontier)
    })

    log.debug({ docKey, count: deltaBatch.updates.length }, 'appended deltas')
    return { frontier: cloneBytes(newFrontier) }
  }

  /**
   * The returned `frontier` is the doc's *current* frontier (from
   * canvasDocFrontiers), not the frontier of the last delta row — a
   * saveSnapshot that runs after the last appendDeltas call still advances
   * what this method reports, matching InMemoryDocumentStore's single
   * per-doc `frontier` field that both write paths update.
   */
  async loadDeltas({ docRef, afterSeq }: LoadDeltasInput): Promise<LoadDeltasResult> {
    const docKey = docRefKey(docRef)
    // `?? null` rather than a bare `!== null`: a caller that omits the field
    // reads as `undefined`, and `where seq > NULL` matches no row — an
    // omission would silently answer "you are caught up" for every document.
    const after = afterSeq ?? null
    // One transaction across all four reads: a fold landing between them
    // would answer a log from before it and a generation from after, which is
    // exactly the pair a tailing reader uses to decide it is caught up.
    return this.db.transaction().execute(async (trx) => {
      const [rows, highest, snapshot, frontierRow] = await Promise.all([
        trx
          .selectFrom('documentDeltas')
          .select('bytes')
          .where('docKey', '=', docKey)
          .$if(after !== null, (qb) => qb.where('seq', '>', after as number))
          .orderBy('seq', 'asc')
          .execute(),
        // The highest seq in the WHOLE log, not among the rows returned, so a
        // caller that is already caught up still learns where to resume.
        trx
          .selectFrom('documentDeltas')
          .select((eb) => eb.fn.max('seq').as('maxSeq'))
          .where('docKey', '=', docKey)
          .executeTakeFirst(),
        trx
          .selectFrom('documentSnapshots')
          .select('generation')
          .where('docKey', '=', docKey)
          .executeTakeFirst(),
        trx
          .selectFrom('documentFrontiers')
          .select('frontier')
          .where('docKey', '=', docKey)
          .executeTakeFirst(),
      ])

      return {
        updates: rows.map((row) => normalizeBlob(row.bytes)),
        lastSeq: highest?.maxSeq ?? null,
        generation: snapshot?.generation ?? null,
        frontier: frontierRow ? normalizeBlob(frontierRow.frontier) : new Uint8Array(),
      }
    })
  }

  async readFrontier({ docRef }: ReadFrontierInput): Promise<ReadFrontierResult> {
    const docKey = docRefKey(docRef)
    const row = await this.db
      .selectFrom('documentFrontiers')
      .select('frontier')
      .where('docKey', '=', docKey)
      .executeTakeFirst()
    if (!row) {
      return null
    }
    return { frontier: normalizeBlob(row.frontier) }
  }
}
