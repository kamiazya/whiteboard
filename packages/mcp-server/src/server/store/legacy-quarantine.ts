import { readFile, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Quarantine old .json version metadata that is missing frontiers by renaming it to
// `.legacy-bak` once at startup.
// Keeping those files in place makes FileVersionStore.list fail with 500, which blocks
// BranchTabs and VersionTimeline rendering. The contents are preserved, so rollback stays possible.
//
// Run this during server daemon startup while creating the app. It is intentionally
// fire-and-forget best effort and must not block startup.
//
// Scope: only DATA_DIR/*/versions/*.json. Do not touch checkpoints or top-level canvas .loro files.

export interface QuarantineResult {
  movedCount: number
  scannedSessions: number
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

function looksCorrupt(raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return true
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const meta = parsed as { frontiers?: unknown }
  // frontiers is required. Missing or empty values are quarantined as legacy metadata.
  if (typeof meta.frontiers !== 'string' || meta.frontiers.length === 0) return true
  return false
}

export async function quarantineLegacyVersionMeta(dataDir: string): Promise<QuarantineResult> {
  if (!(await isDir(dataDir))) {
    return { movedCount: 0, scannedSessions: 0 }
  }
  let movedCount = 0
  let scannedSessions = 0
  let sessionEntries: string[] = []
  try {
    sessionEntries = await readdir(dataDir)
  } catch {
    return { movedCount: 0, scannedSessions: 0 }
  }

  for (const workspaceId of sessionEntries) {
    if (workspaceId.startsWith('.')) continue // Skip dot-prefixed entries such as `.names.json`.
    const versionsDir = join(dataDir, workspaceId, 'versions')
    if (!(await isDir(versionsDir))) continue
    scannedSessions += 1
    let files: string[] = []
    try {
      files = await readdir(versionsDir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      if (f.endsWith('.legacy-bak')) continue
      const p = join(versionsDir, f)
      let raw: string
      try {
        raw = await readFile(p, 'utf-8')
      } catch {
        continue
      }
      if (!looksCorrupt(raw)) continue
      try {
        await rename(p, p + '.legacy-bak')
        movedCount += 1
      } catch {
        /* best-effort */
      }
    }
  }
  return { movedCount, scannedSessions }
}
