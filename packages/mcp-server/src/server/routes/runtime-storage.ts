// Storage usage report for filesystem-backed whiteboard data.
//
// Goals (in order):
//   1. Visibility — users / operators need to see what is growing before we
//      can sensibly enforce caps.
//   2. Cheapness — recursively walk getDataDir() with stat() but never read blob
//      contents. The numbers refresh on demand from the filesystem; nothing
//      is cached or background-scheduled.
//
// Returns totals plus per-category breakdowns so the consumer can spot the
// fastest-growing slice without writing a separate tool.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  StorageBucket,
  StorageCategory,
  StorageReportPayload,
} from '../../shared/api-contracts/document.js'

// Derived from the wire schema rather than written alongside it. A
// hand-written interface beside a Zod schema is the shape that shipped the
// `create_frame` `assignedMembers` bug, and here the two had already drifted
// in the direction nobody sees: the schema's `byCategory` was an open
// `z.record(z.string(), …)`, so the Storage tab could ask for a category this
// walk never produces and get a permanent 0 B row instead of a failure.
//
// `exports` holds the PNG / JSON files a user exported. It is kept out of
// "other" because it is legitimate user data the UI must not invite them to
// delete. `logs` is daemon operational data, usually safe to clean up, split
// out so a user can tell what is actually growing.
export type StorageReport = StorageReportPayload

function emptyBucket(): StorageBucket {
  return { bytes: 0, files: 0 }
}

// Categorise a path under getDataDir(). Mirrors the layout the daemon actually
// writes today:
//   blobs/<workspaceId>/document/<id>.loro         — canvas Loro snapshots
//   blobs/<workspaceId>/versions/<id>.png        — version thumbnails
//   <workspaceId>/files/<id>.png                 — user-uploaded files
//   <workspaceId>/exports/<file>.png             — export artifacts
//   logs/                                        — daemon log files
//   whiteboard.db / .db-wal / .db-shm            — metadata SQLite
//   daemon.json                                   — port + token registry
function categorize(relPath: string): StorageCategory {
  const segments = relPath.split('/').filter(Boolean)
  const head = segments[0] ?? ''
  if (head === 'blobs') {
    // Version thumbnails live at blobs/<ws>/versions/{id}.png; canvas
    // snapshots at blobs/<ws>/document/{id}.loro. Anything else under blobs/
    // is treated as canvas storage.
    if (segments[2] === 'versions') return 'versions'
    return 'blobs'
  }
  if (head === 'logs') return 'logs'
  // Per-workspace subtrees: <ws>/files, <ws>/exports.
  if (segments[1] === 'files') return 'files'
  if (segments[1] === 'exports') return 'exports'
  // Top-level db files: whiteboard.db, whiteboard.db-wal, whiteboard.db-shm.
  if (segments.length === 1 && head.startsWith('whiteboard.db')) return 'db'
  // daemon.json (port + token registry) lives at the data-dir root.
  if (segments.length === 1 && head === 'daemon.json') return 'db'
  return 'other'
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
    const rel = fullPath.slice(root.length + 1)
    const category = categorize(rel)
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
      versions: emptyBucket(),
      files: emptyBucket(),
      db: emptyBucket(),
      exports: emptyBucket(),
      logs: emptyBucket(),
      other: emptyBucket(),
    },
  }
  await walk(dataDir, dataDir, report)
  return report
}
