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

export const resolveSessionId = resolveWorkspaceId
export const saveLatestSessionId = saveCurrentWorkspaceId
