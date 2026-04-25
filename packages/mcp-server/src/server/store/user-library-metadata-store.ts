import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateUserLibraryName } from '../validators.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'
import { USER_LIBRARY_DIRNAME } from './user-library-store.js'

export const USER_LIBRARY_METADATA_FILENAME_SUFFIX = '.meta.json'

export interface UserLibraryMetadataManifest {
  version: 1
  revision: number
  aliases: Record<string, number>
  notes: Record<string, string>
  scales: Record<string, number>
}

export class UserLibraryMetadataConflictError extends Error {
  readonly code = 'conflict'

  constructor(message: string) {
    super(message)
    this.name = 'UserLibraryMetadataConflictError'
  }
}

type MetadataSetPatch = Pick<UserLibraryMetadataManifest, 'aliases' | 'notes' | 'scales'>
type MetadataDeletePatch = {
  aliasKeys?: string[]
  noteKeys?: string[]
  scaleKeys?: string[]
}

function userLibraryDir(): string {
  return join(DATA_DIR, USER_LIBRARY_DIRNAME)
}

function metadataPathFor(name: string): string {
  validateUserLibraryName(name)
  return join(userLibraryDir(), `${name}${USER_LIBRARY_METADATA_FILENAME_SUFFIX}`)
}

function emptyManifest(): UserLibraryMetadataManifest {
  return {
    version: 1,
    revision: 0,
    aliases: {},
    notes: {},
    scales: {},
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNumberMap(
  path: string,
  value: unknown,
  field: 'aliases' | 'scales',
  integerOnly: boolean,
): Record<string, number> {
  if (!isObjectRecord(value)) {
    throw corruptStoredData(path, `expected ${field} to be an object`)
  }
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || Number.isNaN(raw) || !Number.isFinite(raw)) {
      throw corruptStoredData(path, `expected ${field}.${key} to be a finite number`)
    }
    if (integerOnly && !Number.isInteger(raw)) {
      throw corruptStoredData(path, `expected ${field}.${key} to be an integer`)
    }
    out[key] = raw
  }
  return out
}

function parseStringMap(path: string, value: unknown, field: 'notes'): Record<string, string> {
  if (!isObjectRecord(value)) {
    throw corruptStoredData(path, `expected ${field} to be an object`)
  }
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      throw corruptStoredData(path, `expected ${field}.${key} to be a string`)
    }
    out[key] = raw
  }
  return out
}

function parseUserLibraryMetadata(
  path: string,
  raw: string,
): UserLibraryMetadataManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw corruptStoredData(path, 'expected valid user library metadata JSON')
  }
  if (!isObjectRecord(parsed)) {
    throw corruptStoredData(path, 'expected metadata object payload')
  }
  if (parsed.version !== 1) {
    throw corruptStoredData(path, `expected version 1 metadata manifest`)
  }
  if (
    typeof parsed.revision !== 'number' ||
    !Number.isInteger(parsed.revision) ||
    parsed.revision < 0
  ) {
    throw corruptStoredData(path, 'expected revision to be a non-negative integer')
  }
  return {
    version: 1,
    revision: parsed.revision,
    aliases: parseNumberMap(path, parsed.aliases, 'aliases', true),
    notes: parseStringMap(path, parsed.notes, 'notes'),
    scales: parseNumberMap(path, parsed.scales, 'scales', false),
  }
}

async function writeMetadataAtomically(
  path: string,
  manifest: UserLibraryMetadataManifest,
): Promise<void> {
  const dir = userLibraryDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    throw corruptStoredData(dir, `failed to create user library directory (${errorMessage(error)})`)
  }
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(manifest, null, 2))
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw corruptStoredData(path, `failed to write user library metadata (${errorMessage(error)})`)
  }
}

function cloneManifest(manifest: UserLibraryMetadataManifest): UserLibraryMetadataManifest {
  return {
    version: 1,
    revision: manifest.revision,
    aliases: { ...manifest.aliases },
    notes: { ...manifest.notes },
    scales: { ...manifest.scales },
  }
}

export async function getUserLibraryMetadata(
  name: string,
): Promise<UserLibraryMetadataManifest> {
  const path = metadataPathFor(name)
  try {
    const raw = await readFile(path, 'utf-8')
    return parseUserLibraryMetadata(path, raw)
  } catch (error) {
    if (isMissingFileError(error)) return emptyManifest()
    throw error
  }
}

export async function setUserLibraryMetadata(
  name: string,
  revision: number,
  patch: Partial<MetadataSetPatch>,
): Promise<UserLibraryMetadataManifest> {
  const path = metadataPathFor(name)
  const current = await getUserLibraryMetadata(name)
  if (current.revision !== revision) {
    throw new UserLibraryMetadataConflictError(
      `user library metadata revision mismatch for "${name}": expected ${revision}, current ${current.revision}`,
    )
  }
  const next = cloneManifest(current)
  if (patch.aliases) next.aliases = { ...next.aliases, ...patch.aliases }
  if (patch.notes) next.notes = { ...next.notes, ...patch.notes }
  if (patch.scales) next.scales = { ...next.scales, ...patch.scales }
  next.revision = current.revision + 1
  await writeMetadataAtomically(path, next)
  return next
}

export async function deleteUserLibraryMetadata(
  name: string,
  revision: number,
  patch: MetadataDeletePatch,
): Promise<UserLibraryMetadataManifest> {
  const path = metadataPathFor(name)
  const current = await getUserLibraryMetadata(name)
  if (current.revision !== revision) {
    throw new UserLibraryMetadataConflictError(
      `user library metadata revision mismatch for "${name}": expected ${revision}, current ${current.revision}`,
    )
  }
  const next = cloneManifest(current)
  for (const key of patch.aliasKeys ?? []) delete next.aliases[key]
  for (const key of patch.noteKeys ?? []) delete next.notes[key]
  for (const key of patch.scaleKeys ?? []) delete next.scales[key]
  next.revision = current.revision + 1
  await writeMetadataAtomically(path, next)
  return next
}

export async function removeUserLibraryMetadata(name: string): Promise<void> {
  try {
    await unlink(metadataPathFor(name))
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
}
