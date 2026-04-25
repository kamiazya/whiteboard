import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateSessionId, validateSlug } from '../validators.js'
import { assertPathWithinDir } from './path-guard.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'

// Store human-readable Session / Canvas names and UI pin state.
// Backed by one file per session:
//   DATA_DIR/{sessionId}/.names.json
//   {
//     "workspace": "Product Sync Workspace",  // optional. UI falls back to session id when absent.
//     "canvases": { "<slug>": "Architecture overview", ... },  // slug -> display name
//     "pinned": ["architecture/overview", ...]  // slugs pinned to the top of the canvas switcher
//   }
// - Naming and pinning are both optional. When unset, the UI keeps the existing recency/group behavior.
// - Pin order matches array order. The first entry appears first; unpinning simply removes it.
// - Missing files (first run) return an empty state.
// - If the session directory does not exist, create it on write. Reads still return empty.
// - Concurrent writes are not atomic, but the file is small JSON within one process, so the risk is minimal.

export interface SessionNames {
  workspace?: string
  canvases: Record<string, string>
  pinned: string[]
}

const FILE_NAME = '.names.json'

function sessionDir(sessionId: string): string {
  validateSessionId(sessionId)
  const dir = join(DATA_DIR, sessionId)
  return assertPathWithinDir(dir, DATA_DIR, 'session path')
}

function namesPath(sessionId: string): string {
  return assertPathWithinDir(join(sessionDir(sessionId), FILE_NAME), DATA_DIR, 'session path')
}

function parseSessionNames(path: string, raw: string): SessionNames {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw corruptStoredData(path, 'expected valid SessionNames JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corruptStoredData(path, 'expected object with workspace/canvases/pinned')
  }

  const data = parsed as {
    workspace?: unknown
    canvases?: unknown
    pinned?: unknown
  }

  if (data.workspace !== undefined && typeof data.workspace !== 'string') {
    throw corruptStoredData(path, 'expected workspace to be a string when present')
  }
  if (
    data.canvases !== undefined &&
    (typeof data.canvases !== 'object' || data.canvases === null || Array.isArray(data.canvases))
  ) {
    throw corruptStoredData(path, 'expected canvases to be an object when present')
  }
  if (
    data.canvases !== undefined &&
    Object.values(data.canvases as Record<string, unknown>).some((value) => typeof value !== 'string')
  ) {
    throw corruptStoredData(path, 'expected canvases values to be strings')
  }
  if (data.pinned !== undefined && !Array.isArray(data.pinned)) {
    throw corruptStoredData(path, 'expected pinned to be a string[] when present')
  }
  if (Array.isArray(data.pinned) && data.pinned.some((value) => typeof value !== 'string')) {
    throw corruptStoredData(path, 'expected pinned to be a string[] when present')
  }

  return {
    workspace:
      typeof data.workspace === 'string' && data.workspace.length > 0 ? data.workspace : undefined,
    canvases: { ...((data.canvases as Record<string, string> | undefined) ?? {}) },
    pinned: [...((data.pinned as string[] | undefined) ?? [])],
  }
}

export async function loadSessionNames(sessionId: string): Promise<SessionNames> {
  const path = namesPath(sessionId)
  try {
    const raw = await readFile(path, 'utf-8')
    return parseSessionNames(path, raw)
  } catch (error) {
    if (isMissingFileError(error)) {
      return { canvases: {}, pinned: [] }
    }
    if (error instanceof Error) {
      throw error
    }
    return { canvases: {}, pinned: [] }
  }
}

async function saveSessionNames(sessionId: string, names: SessionNames): Promise<void> {
  const dir = sessionDir(sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(namesPath(sessionId), JSON.stringify(names, null, 2))
}

// Set the workspace (session) name. Treat the empty string as delete (back to undefined).
export async function setWorkspaceName(sessionId: string, name: string): Promise<SessionNames> {
  const current = await loadSessionNames(sessionId)
  const trimmed = name.trim()
  const next: SessionNames = {
    ...current,
    workspace: trimmed.length > 0 ? trimmed : undefined,
  }
  // Remove the property entirely when it becomes undefined.
  if (next.workspace === undefined) delete next.workspace
  await saveSessionNames(sessionId, next)
  return next
}

// Set the canvas (slug) name. Empty string deletes it.
export async function setCanvasName(
  sessionId: string,
  slug: string,
  name: string,
): Promise<SessionNames> {
  validateSlug(slug)
  const current = await loadSessionNames(sessionId)
  const trimmed = name.trim()
  const canvases = { ...current.canvases }
  if (trimmed.length > 0) {
    canvases[slug] = trimmed
  } else {
    delete canvases[slug]
  }
  const next: SessionNames = { ...current, canvases }
  await saveSessionNames(sessionId, next)
  return next
}

// Toggle canvas pin state. Idempotent:
// - pinned=true + missing entry -> append to the end
// - pinned=true + already present -> no-op, preserving order
// - pinned=false -> remove from the array
export async function setCanvasPinned(
  sessionId: string,
  slug: string,
  pinned: boolean,
): Promise<SessionNames> {
  validateSlug(slug)
  const current = await loadSessionNames(sessionId)
  const already = current.pinned.includes(slug)
  let nextPinned: string[]
  if (pinned && !already) {
    nextPinned = [...current.pinned, slug]
  } else if (!pinned && already) {
    nextPinned = current.pinned.filter((s) => s !== slug)
  } else {
    nextPinned = current.pinned
  }
  const next: SessionNames = { ...current, pinned: nextPinned }
  await saveSessionNames(sessionId, next)
  return next
}
