import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateUserLibraryName } from '../validators.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'

// Store user-managed .excalidrawlib files across sessions.
// Location: {DATA_DIR}/.user-libraries/{name}.excalidrawlib
// Dot-prefixed directories under DATA_DIR are already excluded from canvas-store listWorkspaces.

export const USER_LIBRARY_DIRNAME = '.user-libraries'
const EXT = '.excalidrawlib'

// name must be a single segment. Allow only alphanumeric characters plus `-` / `_` / `.`,
// and reject `/`, `\`, and `..` to prevent path traversal while keeping names UI-friendly.
function userLibraryDir(): string {
  return join(DATA_DIR, USER_LIBRARY_DIRNAME)
}

function pathFor(name: string): string {
  return join(userLibraryDir(), `${name}${EXT}`)
}

function parseUserLibraryContent(path: string, raw: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw corruptStoredData(path, 'expected valid .excalidrawlib JSON payload')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corruptStoredData(path, 'expected object payload')
  }

  const payload = parsed as { type?: unknown; library?: unknown; libraryItems?: unknown }
  if (payload.type !== 'excalidrawlib') {
    throw corruptStoredData(path, 'expected type "excalidrawlib"')
  }
  if (payload.library !== undefined && !Array.isArray(payload.library)) {
    throw corruptStoredData(path, 'expected library to be an array when present')
  }
  if (payload.libraryItems !== undefined && !Array.isArray(payload.libraryItems)) {
    throw corruptStoredData(path, 'expected libraryItems to be an array when present')
  }

  return parsed
}

function countLibraryItems(content: unknown): number {
  const payload = content as { library?: unknown[]; libraryItems?: unknown[] }
  return payload.libraryItems?.length ?? payload.library?.length ?? 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

// ── write ──
export async function saveUserLibrary(name: string, content: unknown): Promise<void> {
  validateUserLibraryName(name)
  const dir = userLibraryDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    throw corruptStoredData(dir, `failed to create user library directory (${errorMessage(error)})`)
  }
  const path = pathFor(name)
  try {
    await writeFile(path, JSON.stringify(content, null, 2))
  } catch (error) {
    throw corruptStoredData(path, `failed to write user library payload (${errorMessage(error)})`)
  }
}

// ── read ──
export async function loadUserLibrary(name: string): Promise<unknown | null> {
  validateUserLibraryName(name)
  const path = pathFor(name)
  try {
    const raw = await readFile(path, 'utf-8')
    return parseUserLibraryContent(path, raw)
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    if (error instanceof Error) {
      throw error
    }
    return null
  }
}

// ── list ──
// Return each entry with a lightweight item count (v1: library[], v2: libraryItems[]).
// Invalid files fail loudly instead of being skipped.
export interface UserLibrarySummary {
  name: string
  path: string
  itemCount: number
}

export async function listUserLibraries(): Promise<UserLibrarySummary[]> {
  const dir = userLibraryDir()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }
    throw corruptStoredData(dir, 'failed to read user library directory')
  }
  const results: UserLibrarySummary[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(EXT)) continue
    const name = entry.name.slice(0, -EXT.length)
    const p = join(dir, entry.name)
    let raw: string
    try {
      raw = await readFile(p, 'utf-8')
    } catch (error) {
      throw corruptStoredData(
        p,
        error instanceof Error ? `failed to read payload (${error.message})` : 'failed to read payload',
      )
    }
    const parsed = parseUserLibraryContent(p, raw)
    results.push({ name, path: p, itemCount: countLibraryItems(parsed) })
  }
  // Keep the result order stable.
  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

// ── remove ──
export async function removeUserLibrary(name: string): Promise<void> {
  validateUserLibraryName(name)
  try {
    await unlink(pathFor(name))
  } catch (error) {
    if (isMissingFileError(error)) {
      return
    }
    throw error
  }
}
