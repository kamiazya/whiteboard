import { readdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import type { Database } from './index.js'

// Identity-convergence cleanup: once migration 0011 (plus its startup
// re-invocation) has proven a `blobs/<ws>/canvas/<id>.loro` file's bytes
// live in the Libsql snapshot tables, the FS copy is redundant and safe to
// delete. Deletion is self-gating on that proof rather than on the import
// having merely RUN — a matched `documentSnapshots` row whose reassembled
// bytes diverge from the file, or whose `documentFrontiers` backfill never
// completed, is left alone for the next import pass or manual triage. This
// module is deliberately separate from `importFsBlobs`: migration 0011's
// `up()` never calls it, so the migration's additive-only contract holds
// structurally, not by convention.
//
// ponytail: read-compare-unlink without a lock. A pre-flip writer could
// replace the blob between the read and the unlink; accepted because the
// window is single-machine and the next prepare re-imports any survivor.
// Upgrade to rename-then-verify if concurrent pre-flip writers reappear.
export async function sweepImportedFsBlobs(db: Database, dataDir: string): Promise<void> {
  const blobsRoot = join(dataDir, 'blobs')
  const workspaceIds = await readDirSafe(blobsRoot)
  for (const workspaceId of workspaceIds) {
    const canvasDir = join(blobsRoot, workspaceId, 'canvas')
    const files = await readDirSafe(canvasDir)
    for (const file of files) {
      if (!file.endsWith('.loro')) continue
      const documentId = file.slice(0, -'.loro'.length)
      await sweepOneBlob(db, documentId, join(canvasDir, file))
    }
    await rmdirIfEmpty(canvasDir)
    await rmdirIfEmpty(join(blobsRoot, workspaceId))
  }
  await rmdirIfEmpty(blobsRoot)
}

/** `readdir` a directory that may not exist (or may not BE a directory); both are a clean no-op. */
async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
}

/** `rmdir` a directory that may already be gone or non-empty; both are a clean no-op — a sibling versions/thumbnail or a `.pre-migrate-bak` file is expected to keep it alive. */
async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'ENOENT' || code === 'ENOTDIR') return
    throw err
  }
}

async function sweepOneBlob(db: Database, documentId: string, blobPath: string): Promise<void> {
  const docKey = `canvas:${documentId}`

  const snapshot = await db
    .selectFrom('documentSnapshots')
    .select(['chunkCount', 'totalBytes', 'maxChunkBytes'])
    .where('docKey', '=', docKey)
    .executeTakeFirst()
  // No row yet: the import either hasn't reached this blob or the blob
  // failed to decode (garbage/zero-byte). Either way, not provably imported.
  if (!snapshot) return

  // A frontier row is part of a complete import (see importFsBlobs's own
  // backfill step) — a matched snapshot with no frontier row is a failed
  // import for this purpose, kept for the next pass to finish.
  const frontierRow = await db
    .selectFrom('documentFrontiers')
    .select('docKey')
    .where('docKey', '=', docKey)
    .executeTakeFirst()
  if (!frontierRow) return

  let blobBytes: Uint8Array
  try {
    blobBytes = await readFile(blobPath)
  } catch {
    return
  }

  const chunkRows = await db
    .selectFrom('documentSnapshotChunks')
    .select(['chunkIndex', 'bytes'])
    .where('docKey', '=', docKey)
    .orderBy('chunkIndex', 'asc')
    .execute()

  let reassembled: Uint8Array
  try {
    reassembled = reassembleSnapshot(
      {
        chunkCount: snapshot.chunkCount,
        totalBytes: snapshot.totalBytes,
        maxChunkBytes: snapshot.maxChunkBytes,
      },
      chunkRows.map((row) => ({
        index: row.chunkIndex,
        of: snapshot.chunkCount,
        // Fresh copy: drivers hand back Buffer or Uint8Array by dialect, and
        // ports' DTOs require an `ArrayBuffer`-backed `Uint8Array<ArrayBuffer>`.
        bytes: new Uint8Array(row.bytes),
      })),
    )
  } catch {
    // Structurally inconsistent row/chunks — leave for manual triage,
    // matching importFsBlobs's own gate on the same failure shape.
    return
  }

  // The self-gating invariant: only a byte-identical reassembly proves the
  // DB already holds this blob's bytes. Row existence alone is not enough —
  // a divergent row (the drift-fork case importFsBlobs warns about and
  // leaves untouched) must never cost the FS copy its only surviving bytes.
  if (Buffer.compare(reassembled, blobBytes) !== 0) return

  await unlink(blobPath)
}
