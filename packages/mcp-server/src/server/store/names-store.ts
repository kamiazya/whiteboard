import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateWorkspaceId, validateSlug } from '../validators.js'
import { assertPathWithinDir } from './path-guard.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'

// Store human-readable Session / Canvas names and UI pin state.
// Backed by one file per session:
//   DATA_DIR/{workspaceId}/.names.json
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

export interface WorkspaceNames {
  workspace?: string
  canvases: Record<string, string>
  pinned: string[]
}

const FILE_NAME = '.names.json'

function workspaceDir(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  const dir = join(DATA_DIR, workspaceId)
  return assertPathWithinDir(dir, DATA_DIR, 'session path')
}

function namesPath(workspaceId: string): string {
  return assertPathWithinDir(join(workspaceDir(workspaceId), FILE_NAME), DATA_DIR, 'session path')
}

function parseWorkspaceNames(path: string, raw: string): WorkspaceNames {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw corruptStoredData(path, 'expected valid WorkspaceNames JSON')
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

export async function loadWorkspaceNames(workspaceId: string): Promise<WorkspaceNames> {
  const path = namesPath(workspaceId)
  try {
    const raw = await readFile(path, 'utf-8')
    return parseWorkspaceNames(path, raw)
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

async function saveWorkspaceNames(workspaceId: string, names: WorkspaceNames): Promise<void> {
  const dir = workspaceDir(workspaceId)
  await mkdir(dir, { recursive: true })
  await writeFile(namesPath(workspaceId), JSON.stringify(names, null, 2))
}

// Set the workspace (session) name. Treat the empty string as delete (back to undefined).
export async function setWorkspaceName(workspaceId: string, name: string): Promise<WorkspaceNames> {
  const current = await loadWorkspaceNames(workspaceId)
  const trimmed = name.trim()
  const next: WorkspaceNames = {
    ...current,
    workspace: trimmed.length > 0 ? trimmed : undefined,
  }
  // Remove the property entirely when it becomes undefined.
  if (next.workspace === undefined) delete next.workspace
  await saveWorkspaceNames(workspaceId, next)
  return next
}

// Set the canvas (slug) name. Empty string deletes it.
export async function setCanvasName(
  workspaceId: string,
  slug: string,
  name: string,
): Promise<WorkspaceNames> {
  validateSlug(slug)
  const current = await loadWorkspaceNames(workspaceId)
  const trimmed = name.trim()
  const canvases = { ...current.canvases }
  if (trimmed.length > 0) {
    canvases[slug] = trimmed
  } else {
    delete canvases[slug]
  }
  const next: WorkspaceNames = { ...current, canvases }
  await saveWorkspaceNames(workspaceId, next)
  return next
}

// Toggle canvas pin state. Idempotent:
// - pinned=true + missing entry -> append to the end
// - pinned=true + already present -> no-op, preserving order
// - pinned=false -> remove from the array
export async function setCanvasPinned(
  workspaceId: string,
  slug: string,
  pinned: boolean,
): Promise<WorkspaceNames> {
  validateSlug(slug)
  const current = await loadWorkspaceNames(workspaceId)
  const already = current.pinned.includes(slug)
  let nextPinned: string[]
  if (pinned && !already) {
    nextPinned = [...current.pinned, slug]
  } else if (!pinned && already) {
    nextPinned = current.pinned.filter((s) => s !== slug)
  } else {
    nextPinned = current.pinned
  }
  const next: WorkspaceNames = { ...current, pinned: nextPinned }
  await saveWorkspaceNames(workspaceId, next)
  return next
}
