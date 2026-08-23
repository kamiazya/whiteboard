import { access, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DOCUMENT_DOC_KEY_PREFIX, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import type { Database } from './index.js'
import { readDirSafe } from './migrations/0011-import-fs-blobs.js'

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
// Deletion is rename-then-verify, not read-then-unlink: the candidate is
// first renamed to a private `.sweeping` sibling, and only those renamed
// bytes are compared and unlinked. Nothing in this codebase writes a blob
// after the Libsql flip, but a pre-flip process sharing the dataDir could —
// and with a plain read-compare-unlink it could replace the file between
// the two, so the sweep would verify bytes A and delete bytes B. After the
// rename, such a writer lands on the original pathname instead, its file
// survives untouched, and the next startup import picks it up. Verification
// failure renames the candidate back, so a divergent or undecodable blob
// keeps its original name for triage.
/** Private name a candidate wears while it is being verified. Not `.loro`, so the walk never treats it as a blob. */
const CLAIM_SUFFIX = '.sweeping'

export async function sweepImportedFsBlobs(db: Database, dataDir: string): Promise<void> {
  const blobsRoot = join(dataDir, 'blobs')
  const workspaceIds = await readDirSafe(blobsRoot)
  for (const workspaceId of workspaceIds) {
    const canvasDir = join(blobsRoot, workspaceId, 'canvas')
    // A `.sweeping` file is a candidate claimed by a pass that died before
    // finishing. Put it back first so this pass judges it normally rather
    // than leaving it invisible to both the walk (it is not `.loro`) and
    // the next import.
    for (const leftover of await readDirSafe(canvasDir)) {
      if (!leftover.endsWith(CLAIM_SUFFIX)) continue
      const claimed = join(canvasDir, leftover)
      await restore(claimed, claimed.slice(0, -CLAIM_SUFFIX.length))
    }
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
  // Must match what the boot-time import just wrote, which is the live
  // prefix — not the one migration 0011 was recorded with.
  const docKey = `${DOCUMENT_DOC_KEY_PREFIX}${documentId}`

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

  // Claim the candidate under a private name BEFORE reading it, so the
  // bytes compared below are the same bytes unlinked at the end even if a
  // pre-flip writer replaces the original pathname meanwhile.
  const claimedPath = `${blobPath}${CLAIM_SUFFIX}`
  try {
    await rename(blobPath, claimedPath)
  } catch (err) {
    // Gone already (a concurrent delete, or a previous pass) — nothing to
    // sweep. Any OTHER failure (permissions, read-only mount) is a real
    // condition the operator should hear about, so it propagates to
    // prepare's best-effort wrapper rather than being swallowed here.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  let blobBytes: Uint8Array
  try {
    blobBytes = await readFile(claimedPath)
  } catch {
    await restore(claimedPath, blobPath)
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
    await restore(claimedPath, blobPath)
    return
  }

  // The self-gating invariant: only a byte-identical reassembly proves the
  // DB already holds this blob's bytes. Row existence alone is not enough —
  // a divergent row (the drift-fork case importFsBlobs warns about and
  // leaves untouched) must never cost the FS copy its only surviving bytes.
  if (Buffer.compare(reassembled, blobBytes) !== 0) {
    await restore(claimedPath, blobPath)
    return
  }

  await unlink(claimedPath)
}

/**
 * Put a claimed candidate back under its original name. A writer that
 * recreated the original in the meantime WINS: `rename` would silently
 * overwrite it (POSIX replaces the destination), so the newer file is left
 * alone and the claimed copy is dropped instead — its bytes are the older
 * ones, and they are already in the DB or will be re-imported from
 * whatever now sits at the original path.
 */
async function restore(claimedPath: string, blobPath: string): Promise<void> {
  try {
    await access(blobPath)
    await unlink(claimedPath).catch(() => {})
    return
  } catch {
    // Original absent — the normal case; put the candidate back.
  }
  try {
    await rename(claimedPath, blobPath)
  } catch {
    await unlink(claimedPath).catch(() => {})
  }
}
