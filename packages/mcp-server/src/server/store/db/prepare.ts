import type { Kysely } from 'kysely'
import { getLogger } from '../../log.js'
import { DOCUMENT_DOC_KEY_PREFIX } from '../doc-ref-key.js'
import { getDb } from './index.js'
import { importFsBlobs } from './migrations/0011-import-fs-blobs.js'
import { runMigrations } from './migrator.js'
import { sweepImportedFsBlobs } from './sweep-imported-fs-blobs.js'

const log = getLogger('prepare')

// Memoized startup hook. Idempotent across repeated calls per dataDir, so
// daemon entry, createApp, smoke tests, and unit tests can all call it
// without coordinating who runs the migrations first.
const ready = new Map<string, Promise<void>>()

export function prepareDataDir(dataDir: string): Promise<void> {
  const existing = ready.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
    const db = await getDb(dataDir)
    await runMigrations(db)
    // Migration 0011 itself runs exactly once (Kysely tracks it by key).
    // The identity-convergence flip needs its import routine to run a
    // SECOND time here, every prepare — closing the window between "0011
    // ran" and "document-store.ts stopped writing FS blobs", during which
    // an old process could still write a fresh blob 0011 never saw. Cheap
    // and idempotent by design (see importFsBlobs's own doc comment).
    // importFsBlobs takes Kysely<unknown> (it defines its own frozen
    // migration-time schema — see its doc comment) and Kysely's method
    // builders are contravariant in their generic params, so the concrete
    // Database type is not structurally assignable without this cast; the
    // same widening Kysely's own Migrator performs internally when it calls
    // migration.up(db).
    await importFsBlobs(db as unknown as Kysely<unknown>, dataDir, DOCUMENT_DOC_KEY_PREFIX)
    // Best-effort: a sweep failure (e.g. an unreadable blobs root) must not
    // block startup the way a failed import does — the FS copies it would
    // have deleted are still safe on disk, so the worst case is deferring
    // cleanup to the next successful boot.
    try {
      await sweepImportedFsBlobs(db, dataDir)
    } catch (err) {
      log.warning(
        { dataDir, err },
        'failed to sweep imported FS blobs, continuing without deleting them',
      )
    }
  })()
  ready.set(dataDir, pending)
  pending.catch(() => {
    // Allow retries on next call after a transient failure.
    if (ready.get(dataDir) === pending) {
      ready.delete(dataDir)
    }
  })
  return pending
}

export function clearPrepareCache(): void {
  ready.clear()
}
