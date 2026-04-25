import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateSessionId } from '../validators.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'

// Persist the list of installed .excalidrawlib URLs per session.
// Location: {DATA_DIR}/{sessionId}/.libraries.json
// Format: { urls: string[] } - only the URLs. The client refetches the actual content.
// Rationale:
//   - URLs alone stay small (typically a few hundred bytes per file)
//   - freshness of the library content stays delegated to upstream maintainers
//   - the Excalidraw library panel primarily uses browser localStorage; the server copy
//     acts as a backup and as a reference point for Claude-side flows

const LIBRARIES_FILENAME = '.libraries.json'

export interface InstalledLibraries {
  urls: string[]
}

function pathFor(sessionId: string): string {
  validateSessionId(sessionId)
  return join(DATA_DIR, sessionId, LIBRARIES_FILENAME)
}

function parseInstalledLibraries(path: string, raw: string): InstalledLibraries {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw corruptStoredData(path, 'expected valid JSON object with urls: string[]')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corruptStoredData(path, 'expected object with urls: string[]')
  }

  const urls = (parsed as { urls?: unknown }).urls
  if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')) {
    throw corruptStoredData(path, 'expected urls: string[]')
  }

  return { urls: [...urls] }
}

export async function loadInstalledLibraries(sessionId: string): Promise<InstalledLibraries> {
  const path = pathFor(sessionId)
  try {
    const raw = await readFile(path, 'utf-8')
    return parseInstalledLibraries(path, raw)
  } catch (error) {
    if (isMissingFileError(error)) {
      return { urls: [] }
    }
    if (error instanceof Error) {
      throw error
    }
    return { urls: [] }
  }
}

export async function saveInstalledLibraries(
  sessionId: string,
  libs: InstalledLibraries,
): Promise<void> {
  await mkdir(join(DATA_DIR, sessionId), { recursive: true })
  await writeFile(pathFor(sessionId), JSON.stringify(libs, null, 2))
}

export async function addInstalledLibrary(sessionId: string, url: string): Promise<InstalledLibraries> {
  const current = await loadInstalledLibraries(sessionId)
  if (current.urls.includes(url)) return current // idempotent
  const next: InstalledLibraries = { urls: [...current.urls, url] }
  await saveInstalledLibraries(sessionId, next)
  return next
}

export async function removeInstalledLibrary(
  sessionId: string,
  url: string,
): Promise<InstalledLibraries> {
  const current = await loadInstalledLibraries(sessionId)
  if (!current.urls.includes(url)) return current
  const next: InstalledLibraries = { urls: current.urls.filter((u) => u !== url) }
  await saveInstalledLibraries(sessionId, next)
  return next
}
