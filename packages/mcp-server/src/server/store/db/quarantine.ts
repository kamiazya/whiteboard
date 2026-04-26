import { mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Database } from './index.js'

// Generic, reusable quarantine helper.
//
// Future migrations also need to safely move legacy on-disk artifacts aside
// before mutating the live layout. Rather than deleting, we rename the source
// path into a deterministic bucket under {dataDir}/.legacy-bak and record the
// move so a re-run can short-circuit and a human can locate the original.
//
// Idempotency: if a (kind, scope, key) row already exists in quarantine_log,
// the helper assumes a previous run already quarantined the same entry and
// returns the recorded bucketPath without touching the filesystem.
//
// Crash safety: the rename is the last step. If the process dies between the
// log INSERT and the rename, the next run will see the row present, skip the
// rename (the source may or may not still be there), and continue. The
// alternative — log AFTER rename — would make a crash mid-operation appear as
// "log entry missing" on retry and leave the bucketPath orphaned. The
// trade-off favors discoverability over strict referential integrity because
// the buckets are user-visible directories.
export interface QuarantineRequest {
  db: Database
  dataDir: string
  kind: string
  scope: string
  key: string
  sourcePath: string
}

export interface QuarantineResult {
  bucketPath: string
  alreadyQuarantined: boolean
}

const LEGACY_BAK_DIRNAME = '.legacy-bak'

function sanitizeKey(key: string): string {
  // Quarantine keys may carry slashes (canvas slugs). Flatten them so the
  // bucket file names stay one segment and never escape the bucket directory.
  return key.replace(/[\\/]/g, '__')
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function quarantine(req: QuarantineRequest): Promise<QuarantineResult> {
  const existing = await req.db
    .selectFrom('quarantine_log')
    .select(['bucketPath'])
    .where('kind', '=', req.kind)
    .where('scope', '=', req.scope)
    .where('key', '=', req.key)
    .executeTakeFirst()
  if (existing) {
    return { bucketPath: existing.bucketPath, alreadyQuarantined: true }
  }

  const bucketDir = join(req.dataDir, LEGACY_BAK_DIRNAME, req.kind, req.scope)
  const bucketPath = join(bucketDir, sanitizeKey(req.key))

  await req.db
    .insertInto('quarantine_log')
    .values({
      kind: req.kind,
      scope: req.scope,
      key: req.key,
      bucketPath,
      createdAt: Date.now(),
    })
    .execute()

  if (!(await pathExists(req.sourcePath))) {
    // Source already moved by a previous interrupted run, or was never there.
    // The log entry above ensures retries skip this branch next time.
    return { bucketPath, alreadyQuarantined: false }
  }

  await mkdir(dirname(bucketPath), { recursive: true })
  await rename(req.sourcePath, bucketPath)
  return { bucketPath, alreadyQuarantined: false }
}
