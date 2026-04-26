import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'

export const CURRENT_WORKSPACE_FILENAME = '.current-workspace'
export const LATEST_SESSION_FILENAME = '.latest-session'

async function readMarker(dataDir: string, fileName: string): Promise<string | null> {
  try {
    const candidate = (await readFile(join(dataDir, fileName), 'utf-8')).trim()
    return candidate.length > 0 ? candidate : null
  } catch {
    return null
  }
}

export async function resolveWorkspaceId(dataDir: string): Promise<string> {
  const current = await readMarker(dataDir, CURRENT_WORKSPACE_FILENAME)
  if (current) return current

  const legacy = await readMarker(dataDir, LATEST_SESSION_FILENAME)
  if (legacy) return legacy

  return nanoid()
}

export async function saveCurrentWorkspaceId(dataDir: string, workspaceId: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, CURRENT_WORKSPACE_FILENAME), workspaceId)
  await writeFile(join(dataDir, LATEST_SESSION_FILENAME), workspaceId)
}

// Memoize the resolve+persist sequence per DATA_DIR so the HTTP /mcp handler
// stops racing concurrent requests on the same marker file. Each entry holds a
// promise so callers that arrive while the first resolution is still inflight
// share its result instead of issuing another pair of file writes.
const ensureCache = new Map<string, Promise<string>>()

export function ensureWorkspaceId(dataDir: string): Promise<string> {
  const existing = ensureCache.get(dataDir)
  if (existing) return existing
  const pending = (async () => {
    const id = await resolveWorkspaceId(dataDir)
    await saveCurrentWorkspaceId(dataDir, id)
    return id
  })()
  ensureCache.set(dataDir, pending)
  pending.catch(() => {
    // Drop the failed entry so a later call can retry instead of re-throwing
    // the original error forever.
    if (ensureCache.get(dataDir) === pending) {
      ensureCache.delete(dataDir)
    }
  })
  return pending
}

export function clearWorkspaceIdCache(): void {
  ensureCache.clear()
}
