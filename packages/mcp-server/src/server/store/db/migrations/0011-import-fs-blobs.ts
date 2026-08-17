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
// The blob path segment (`blobs/<workspaceId>/canvas/<documentId>.loro`) and
// the `canvas:<documentId>` docKey prefix are FROZEN literals copied from
// document-store.ts / doc-ref-key.ts as they stand today — a migration must
// not depend on living code that can change out from under a recorded
// migration key. Same for the table/column shapes in `MigrationSchema`
// below, current as of 0010.
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

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await importFsBlobs(db, getDataDir())
  },

  async down(): Promise<void> {
    // Additive only: nothing was ever overwritten or deleted, so there is
    // nothing to undo.
  },
}

/**
 * Import every `.loro` blob under `{dataDir}/blobs/*\/canvas/*.loro` that has
 * no `documentSnapshots` row for its `canvas:<documentId>` docKey.
 *
 * Exported standalone (not only via the `Migration.up` wrapper) because the
 * repo's migrator runs a migration key exactly once per database — the
 * identity-convergence flip slice needs to call this exact routine a SECOND
 * time outside migration-table bookkeeping, to close the window between
 * "this migration ran" and "the flip stopped writing to the FS store", during
 * which an old process can still write a fresh blob this migration never saw.
 */
export async function importFsBlobs(db: Kysely<unknown>, dataDir: string): Promise<void> {
  const tdb = db as Kysely<MigrationSchema>
  const blobsRoot = join(dataDir, 'blobs')

  const workspaceIds = await readDirSafe(blobsRoot)
  for (const workspaceId of workspaceIds) {
    const canvasDir = join(blobsRoot, workspaceId, 'canvas')
    const files = await readDirSafe(canvasDir)
    for (const file of files) {
      if (!file.endsWith('.loro')) continue
      const documentId = file.slice(0, -'.loro'.length)
      await importOneBlob(tdb, workspaceId, documentId, join(canvasDir, file))
    }
  }
}

/** `readdir` a directory that may not exist (or may not BE a directory — a stray file left directly under `blobs/`); both are a clean no-op. */
async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
}

async function importOneBlob(
  db: Kysely<MigrationSchema>,
  workspaceId: string,
  documentId: string,
  blobPath: string,
): Promise<void> {
  const docKey = `canvas:${documentId}`

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
    const chunkRows = await db
      .selectFrom('documentSnapshotChunks')
      .select(['chunkIndex', 'bytes'])
      .where('docKey', '=', docKey)
      .orderBy('chunkIndex', 'asc')
      .execute()
    const existingBytes = reassembleSnapshot(
      {
        chunkCount: existing.chunkCount,
        totalBytes: existing.totalBytes,
        maxChunkBytes: existing.maxChunkBytes,
      },
      chunkRows.map((row) => ({
        index: row.chunkIndex,
        of: existing.chunkCount,
        bytes: toBytes(row.bytes),
      })),
    )
    if (!bytesEqual(existingBytes, bytes)) {
      log.warning(
        {
          workspaceId,
          documentId,
          existingBytes: existingBytes.byteLength,
          blobBytes: bytes.byteLength,
        },
        'FS blob diverges from an existing snapshot row — leaving both sides untouched for manual triage',
      )
    }
    return
  }

  // documentSnapshots.frontier is NOT NULL, so deriving one is load-bearing:
  // importing through LoroDoc also doubles as the corruption gate — a blob
  // that fails to decode (garbage bytes, a zero-length file) cannot be given
  // a fake frontier, so it is skipped rather than aborting the whole import.
  const doc = new LoroDoc()
  try {
    doc.import(bytes)
  } catch (err) {
    log.warning(
      { workspaceId, documentId, byteLength: bytes.byteLength, err },
      'blob failed to decode as a LoroDoc snapshot, skipping',
    )
    return
  }
  const frontier = encodeFrontiers(doc.oplogFrontiers())

  const { manifest, chunks } = chunkSnapshot(bytes, IMPORT_MAX_CHUNK_BYTES)

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

  const frontierRow = await db
    .selectFrom('documentFrontiers')
    .select('docKey')
    .where('docKey', '=', docKey)
    .executeTakeFirst()
  if (!frontierRow) {
    await db.insertInto('documentFrontiers').values({ docKey, frontier }).execute()
  }
}

/**
 * Drivers hand blobs back as Buffer or Uint8Array depending on dialect. The
 * array-like `Uint8Array` constructor overload always allocates a fresh
 * `ArrayBuffer`-backed copy — unlike a bare `instanceof` passthrough, this is
 * what keeps the result assignable to ports' `Uint8Array<ArrayBuffer>` DTOs.
 */
function toBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
