import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateUserLibraryName } from '../validators.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'

// User-managed `.excalidrawlib` libraries. Backed by:
//   user_libraries table         -> registry row (name, itemCount, timestamps)
//   blobs/.user-libraries/{name}.excalidrawlib  -> the JSON payload
//
// listUserLibraries reads the table; loadUserLibrary parses the FS payload so
// callers still get the original .excalidrawlib structure. The path field on
// UserLibrarySummary remains the absolute FS path so route handlers and MCP
// tools that surface it to UIs do not change shape.

export const USER_LIBRARY_DIRNAME = '.user-libraries'
const EXT = '.excalidrawlib'

function userLibraryBlobsDir(): string {
  return join(DATA_DIR, 'blobs', USER_LIBRARY_DIRNAME)
}

function pathFor(name: string): string {
  return join(userLibraryBlobsDir(), `${name}${EXT}`)
}

async function dbReady() {
  await prepareDataDir(DATA_DIR)
  return getDb(DATA_DIR)
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

export async function saveUserLibrary(name: string, content: unknown): Promise<void> {
  validateUserLibraryName(name)
  const path = pathFor(name)
  await mkdir(dirname(path), { recursive: true })
  // Validate the payload up front so we never persist garbage that listing
  // would later choke on.
  const parsed = parseUserLibraryContent(path, JSON.stringify(content))
  try {
    await writeFile(path, JSON.stringify(content, null, 2))
  } catch (error) {
    throw corruptStoredData(path, `failed to write user library payload (${errorMessage(error)})`)
  }
  const itemCount = countLibraryItems(parsed)
  const now = Date.now()
  const db = await dbReady()
  await db
    .insertInto('user_libraries')
    .values({ name, itemCount, createdAt: now, updatedAt: now })
    .onConflict((oc) => oc.column('name').doUpdateSet({ itemCount, updatedAt: now }))
    .execute()
}

export async function loadUserLibrary(name: string): Promise<unknown | null> {
  validateUserLibraryName(name)
  const path = pathFor(name)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    throw error
  }
  return parseUserLibraryContent(path, raw)
}

export interface UserLibrarySummary {
  name: string
  path: string
  itemCount: number
}

export async function listUserLibraries(): Promise<UserLibrarySummary[]> {
  const db = await dbReady()
  const rows = await db
    .selectFrom('user_libraries')
    .select(['name', 'itemCount'])
    .orderBy('name', 'asc')
    .execute()
  return rows.map((r) => ({
    name: r.name,
    path: pathFor(r.name),
    itemCount: r.itemCount ?? 0,
  }))
}

export async function removeUserLibrary(name: string): Promise<void> {
  validateUserLibraryName(name)
  try {
    await unlink(pathFor(name))
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }
  const db = await dbReady()
  await db.deleteFrom('user_libraries').where('name', '=', name).execute()
}
