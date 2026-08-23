import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import type { Kysely, Migration } from 'kysely'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { getDataDir } from '../../../config.js'
import { getLogger } from '../../../log.js'

const log = getLogger('migration-0011')

// Identity-convergence prerequisite: import every FS blob that has no
// documentSnapshots row yet, so the follow-up "flip" slice can point
// LibsqlDocumentStore at the DB tables without losing history the FS store
// already wrote. Additive only — the FS tree stays the source of truth for
// this migration's lifetime, and document-store.ts/file-gc-sweeper.ts keep
// operating on it unmodified.
//
// The blob path segment (`blobs/<workspaceId>/canvas/<documentId>.loro`) is a
// FROZEN literal copied from document-store.ts as it stands today — a
// migration must not depend on living code that can change out from under a
// recorded migration key. Same for the table/column shapes in
// `MigrationSchema` below, current as of 0010.
//
// The docKey prefix is a PARAMETER for the same reason, not a convenience.
// `migration.up` passes the frozen `canvas:` it was recorded with, so a
// replay reproduces exactly the rows it originally wrote. prepareDataDir
// re-invokes `importFsBlobs` on every boot, AFTER all migrations, and must
// pass the live prefix instead: `0013-document-dockey-prefix` rewrites the
// stored rows to `document:`, and a boot-time import still writing `canvas:`
// would re-seed an orphan copy of every blob the sweep had not yet removed.
const IMPORT_MAX_CHUNK_BYTES = 1_000_000

interface MigrationSchema {
  documentSnapshots: {
    docKey: string
    chunkCount: number
    totalBytes: number
    maxChunkBytes: number
    frontier: Uint8Array
  }
  documentSnapshotChunks: {
    docKey: string
    chunkIndex: number
    bytes: Uint8Array
  }
  documentFrontiers: {
    docKey: string
    frontier: Uint8Array
  }
}

/** The docKey prefix this migration was recorded with. Frozen; see the note above. */
const RECORDED_DOC_KEY_PREFIX = 'canvas:'

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await importFsBlobs(db, getDataDir(), RECORDED_DOC_KEY_PREFIX)
  },

  async down(): Promise<void> {
    // Additive only: nothing was ever overwritten or deleted, so there is
    // nothing to undo.
  },
}

/**
 * Import every `.loro` blob under `{dataDir}/blobs/*\/canvas/*.loro` that has
 * no `documentSnapshots` row for its `<docKeyPrefix><documentId>` docKey.
 *
 * Exported standalone (not only via the `Migration.up` wrapper) because the
 * repo's migrator runs a migration key exactly once per database — the
 * identity-convergence flip slice needs to call this exact routine a SECOND
 * time outside migration-table bookkeeping, to close the window between
 * "this migration ran" and "the flip stopped writing to the FS store", during
 * which an old process can still write a fresh blob this migration never saw.
 */
export async function importFsBlobs(
  db: Kysely<unknown>,
  dataDir: string,
  docKeyPrefix: string,
  /**
   * Chunk size, injectable for the same reason `docKeyPrefix` is: a caller
   * that needs a different value should pass it rather than have the module
   * decide. Here the caller is a TEST — proving that an over-size blob
   * splits needs a blob over the threshold, not a blob over one megabyte,
   * and pushing 1.3MB through SQLite to say so made that test the slowest
   * in the suite and the first to blow the 10s per-test budget under load.
   */
  maxChunkBytes: number = IMPORT_MAX_CHUNK_BYTES,
): Promise<void> {
  const tdb = db as Kysely<MigrationSchema>
  const blobsRoot = join(dataDir, 'blobs')

  const workspaceIds = await readDirSafe(blobsRoot)
  for (const workspaceId of workspaceIds) {
    const canvasDir = join(blobsRoot, workspaceId, 'canvas')
    const files = await readDirSafe(canvasDir)
    for (const file of files) {
      if (!file.endsWith('.loro')) continue
      const documentId = file.slice(0, -'.loro'.length)
      await importOneBlob(
        tdb,
        workspaceId,
        documentId,
        join(canvasDir, file),
        docKeyPrefix,
        maxChunkBytes,
      )
    }
  }
}

/** `readdir` a directory that may not exist (or may not BE a directory — a stray file left directly under `blobs/`); both are a clean no-op. Exported for `sweep-imported-fs-blobs.ts`, which walks the same frozen blob-tree layout — safe to depend on precisely because this file never changes. */
export async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
}

/** Decode `bytes` as a LoroDoc snapshot and encode its current frontier, or the decode error. */
function decodeFrontier(bytes: Uint8Array): { frontier: Uint8Array } | { error: unknown } {
  const doc = new LoroDoc()
  try {
    doc.import(bytes)
  } catch (error) {
    return { error }
  }
  return { frontier: encodeFrontiers(doc.oplogFrontiers()) }
}

async function importOneBlob(
  db: Kysely<MigrationSchema>,
  workspaceId: string,
  documentId: string,
  blobPath: string,
  docKeyPrefix: string,
  maxChunkBytes: number,
): Promise<void> {
  const docKey = `${docKeyPrefix}${documentId}`

  let bytes: Uint8Array
  try {
    bytes = await readFile(blobPath)
  } catch (err) {
    log.warning({ workspaceId, documentId, err }, 'could not read blob during import, skipping')
    return
  }

  const existing = await db
    .selectFrom('documentSnapshots')
    .select(['chunkCount', 'totalBytes', 'maxChunkBytes'])
    .where('docKey', '=', docKey)
    .executeTakeFirst()

  if (existing) {
    // A row already exists — the drift-fork case. Resolving it is not this
    // migration's job (it cannot know which side is authoritative), so it
    // only compares bytes to tell a genuine divergence from an already-
    // imported, unchanged blob (idempotence) and leaves both sides alone
    // either way.
    //
    // reassembleSnapshot can itself throw (SnapshotReassemblyError) when the
    // existing row is structurally inconsistent with its chunk rows — e.g. a
    // prior importOneBlob call was interrupted between its independent
    // documentSnapshots/documentSnapshotChunks inserts. That is symmetric
    // with the decode-failure gate below: skip the one document rather than
    // aborting every other document in this import.
    const chunkRows = await db
      .selectFrom('documentSnapshotChunks')
      .select(['chunkIndex', 'bytes'])
      .where('docKey', '=', docKey)
      .orderBy('chunkIndex', 'asc')
      .execute()
    let existingBytes: Uint8Array
    try {
      existingBytes = reassembleSnapshot(
        {
          chunkCount: existing.chunkCount,
          totalBytes: existing.totalBytes,
          maxChunkBytes: existing.maxChunkBytes,
        },
        chunkRows.map((row) => ({
          index: row.chunkIndex,
          of: existing.chunkCount,
          // Fresh copy: drivers hand back Buffer or Uint8Array by dialect, and
          // ports' DTOs require an `ArrayBuffer`-backed `Uint8Array<ArrayBuffer>`.
          bytes: new Uint8Array(row.bytes),
        })),
      )
    } catch (err) {
      log.warning(
        { workspaceId, documentId, err },
        'existing snapshot row failed to reassemble, leaving both sides untouched for manual triage',
      )
      return
    }
    if (Buffer.compare(existingBytes, bytes) !== 0) {
      log.warning(
        {
          workspaceId,
          documentId,
          existingBytes: existingBytes.byteLength,
          blobBytes: bytes.byteLength,
        },
        'FS blob diverges from an existing snapshot row — leaving both sides untouched for manual triage',
      )
      return
    }

    // Bytes match — already imported by an earlier call. But the three
    // inserts below (documentSnapshots, documentSnapshotChunks,
    // documentFrontiers) are not atomic outside the migration's own wrapping
    // transaction (the standalone export runs without one), so an earlier
    // call can have been interrupted between the chunk pair landing and the
    // frontier insert. Backfill the missing row rather than returning
    // silently: LibsqlDocumentStore.currentFrontier() falls through to an
    // empty frontier for a docKey with no documentFrontiers row, which would
    // misreport this document as having no history despite the full
    // snapshot being present.
    const frontierExists = await db
      .selectFrom('documentFrontiers')
      .select('docKey')
      .where('docKey', '=', docKey)
      .executeTakeFirst()
    if (!frontierExists) {
      const decoded = decodeFrontier(bytes)
      if ('error' in decoded) {
        log.warning(
          { workspaceId, documentId, err: decoded.error },
          'existing snapshot matched the FS blob but it failed to decode while backfilling a missing frontier row, skipping',
        )
        return
      }
      await db
        .insertInto('documentFrontiers')
        .values({ docKey, frontier: decoded.frontier })
        .onConflict((oc) => oc.column('docKey').doNothing())
        .execute()
    }
    return
  }

  // documentSnapshots.frontier is NOT NULL, so deriving one is load-bearing:
  // importing through LoroDoc also doubles as the corruption gate — a blob
  // that fails to decode (garbage bytes, a zero-length file) cannot be given
  // a fake frontier, so it is skipped rather than aborting the whole import.
  const decoded = decodeFrontier(bytes)
  if ('error' in decoded) {
    log.warning(
      { workspaceId, documentId, byteLength: bytes.byteLength, err: decoded.error },
      'blob failed to decode as a LoroDoc snapshot, skipping',
    )
    return
  }
  const frontier = decoded.frontier

  const { manifest, chunks } = chunkSnapshot(bytes, maxChunkBytes)

  await db
    .insertInto('documentSnapshots')
    .values({
      docKey,
      chunkCount: manifest.chunkCount,
      totalBytes: manifest.totalBytes,
      maxChunkBytes: manifest.maxChunkBytes,
      frontier,
    })
    .execute()

  if (chunks.length > 0) {
    await db
      .insertInto('documentSnapshotChunks')
      .values(chunks.map((chunk) => ({ docKey, chunkIndex: chunk.index, bytes: chunk.bytes })))
      .execute()
  }

  await db
    .insertInto('documentFrontiers')
    .values({ docKey, frontier })
    .onConflict((oc) => oc.column('docKey').doNothing())
    .execute()
}
