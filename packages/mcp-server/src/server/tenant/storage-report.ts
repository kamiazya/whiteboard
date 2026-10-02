// Storage usage report for filesystem-backed whiteboard data.
//
// Goals (in order):
//   1. Visibility — users / operators need to see what is growing before we
//      can sensibly enforce caps.
//   2. Cheapness — recursively walk the data directory with stat() but never
//      read blob contents. The numbers refresh on demand from the filesystem;
//      nothing is cached or background-scheduled.
//
// Returns totals plus per-category breakdowns so the consumer can spot the
// fastest-growing slice without writing a separate tool.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  StorageBucket,
  StorageCategory,
  StorageReportPayload,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { DAEMON_RECORD_FILENAME } from '../../daemon/daemon-registry.js'
import { DB_FILENAME } from '../store/db/location.js'
import { storeAreaOf } from './data-layout.js'

// Derived from the wire schema rather than written alongside it. A
// hand-written interface beside a Zod schema is the shape that shipped the
// `create_frame` `assignedMembers` bug, and here the two had already drifted
// in the direction nobody sees: the schema's `byCategory` was an open
// `z.record(z.string(), …)`, so the Storage tab could ask for a category this
// walk never produces and get a permanent 0 B row instead of a failure.
//
// `exports` holds the PNG / JSON files a user exported. It is kept out of
// "other" because it is legitimate user data the UI must not invite them to
// delete.
export type StorageReport = StorageReportPayload

function emptyBucket(): StorageBucket {
  return { bytes: 0, files: 0 }
}

// The database and the daemon record are keeper-wide files at the top of the
// data directory (`data-layout.ts`), so they are classified here by name; the
// SQLite sidecars (`-wal`, `-shm`) share the database's prefix. Version rows
// live in that database, which is why there is no category of their own.
function categoryOf(dataDir: string, path: string): StorageCategory {
  const area = storeAreaOf(dataDir, path)
  if (area !== null) return area
  if (dirname(path) !== dataDir) return 'other'
  const name = basename(path)
  return name.startsWith(DB_FILENAME) || name === DAEMON_RECORD_FILENAME ? 'db' : 'other'
}

async function walk(root: string, current: string, report: StorageReport): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    // Permission errors / missing dirs are best-effort — skip silently.
    return
  }
  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) {
      await walk(root, fullPath, report)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(fullPath)
    } catch {
      continue
    }
    const category = categoryOf(root, fullPath)
    report.byCategory[category].bytes += info.size
    report.byCategory[category].files += 1
    report.totalBytes += info.size
    report.fileCount += 1
  }
}

export async function computeStorageReport(dataDir: string): Promise<StorageReport> {
  const report: StorageReport = {
    totalBytes: 0,
    fileCount: 0,
    byCategory: {
      blobs: emptyBucket(),
      files: emptyBucket(),
      db: emptyBucket(),
      exports: emptyBucket(),
      other: emptyBucket(),
    },
  }
  await walk(dataDir, dataDir, report)
  return report
}
