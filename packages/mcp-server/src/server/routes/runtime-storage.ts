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

import { stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface StorageReport {
  totalBytes: number
  fileCount: number
  byCategory: {
    blobs: { bytes: number; files: number }
    versions: { bytes: number; files: number }
    files: { bytes: number; files: number }
    libraries: { bytes: number; files: number }
    db: { bytes: number; files: number }
    // PNG / JSON exports the user produced via export_canvas.
    // Kept separate from "other" because they are
    // legitimate user data the UI should not invite to delete.
    exports: { bytes: number; files: number }
    // Daemon log files. Operational data — typically safe to clean up
    // periodically, surfaced separately so the user can tell what is
    // actually growing.
    logs: { bytes: number; files: number }
    other: { bytes: number; files: number }
  }
}

interface Bucket {
  bytes: number
  files: number
}

function emptyBucket(): Bucket {
  return { bytes: 0, files: 0 }
}

// Categorise a path under getDataDir(). Mirrors the layout the daemon actually
// writes today:
//   blobs/<workspaceId>/canvas/<id>.loro         — canvas Loro snapshots
//   blobs/<workspaceId>/versions/<id>.png        — version thumbnails
//   blobs/.user-libraries/<name>.excalidrawlib   — user library JSON
//   <workspaceId>/files/<id>.png                 — user-uploaded files
//   <workspaceId>/exports/<file>.excalidraw.png  — export artifacts
//   logs/                                        — daemon log files
//   whiteboard.db / .db-wal / .db-shm            — metadata SQLite
//   daemon.json                                   — port + token registry
function categorize(relPath: string): keyof StorageReport['byCategory'] {
  const segments = relPath.split('/').filter(Boolean)
  const head = segments[0] ?? ''
  if (head === 'blobs') {
    // User libraries are stashed inside blobs/.user-libraries/ to share the
    // same data dir as canvas snapshots — the directory name itself is the
    // discriminator, not the depth.
    if (segments[1] === '.user-libraries') return 'libraries'
    // Version thumbnails live at blobs/<ws>/versions/{id}.png; canvas
    // snapshots at blobs/<ws>/canvas/{id}.loro. Anything else under blobs/
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
  let entries
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
    let info
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
      libraries: emptyBucket(),
      db: emptyBucket(),
      exports: emptyBucket(),
      logs: emptyBucket(),
      other: emptyBucket(),
    },
  }
  await walk(dataDir, dataDir, report)
  return report
}
