import { DATA_DIR } from '../config.js'
import { validateUserLibraryName } from '../validators.js'
import { corruptStoredData } from './corrupt-stored-data.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'

// User library metadata. Backed by:
//   user_library_metadata table -> name PK, manifestJson TEXT (JSON-encoded
//                                  UserLibraryMetadataManifest)
//
// The manifest itself stays a structured object on the wire; on disk it is a
// single JSON column so callers do not need to know the schema. Revision
// conflicts are detected by reading the current row and comparing before
// writing the next one.

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

function emptyManifest(): UserLibraryMetadataManifest {
  return {
    version: 1,
    revision: 0,
    aliases: {},
    notes: {},
    scales: {},
  }
}

async function dbReady() {
  await prepareDataDir(DATA_DIR)
  return getDb(DATA_DIR)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function manifestSource(name: string): string {
  return `user_library_metadata/${name}`
}

function parseNumberMap(
  source: string,
  value: unknown,
  field: 'aliases' | 'scales',
  integerOnly: boolean,
): Record<string, number> {
  if (!isObjectRecord(value)) {
    throw corruptStoredData(source, `expected ${field} to be an object`)
  }
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || Number.isNaN(raw) || !Number.isFinite(raw)) {
      throw corruptStoredData(source, `expected ${field}.${key} to be a finite number`)
    }
    if (integerOnly && !Number.isInteger(raw)) {
      throw corruptStoredData(source, `expected ${field}.${key} to be an integer`)
    }
    out[key] = raw
  }
  return out
}

function parseStringMap(source: string, value: unknown, field: 'notes'): Record<string, string> {
  if (!isObjectRecord(value)) {
    throw corruptStoredData(source, `expected ${field} to be an object`)
  }
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      throw corruptStoredData(source, `expected ${field}.${key} to be a string`)
    }
    out[key] = raw
  }
  return out
}

function parseUserLibraryMetadata(name: string, raw: string): UserLibraryMetadataManifest {
  const source = manifestSource(name)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw corruptStoredData(source, 'expected valid user library metadata JSON')
  }
  if (!isObjectRecord(parsed)) {
    throw corruptStoredData(source, 'expected metadata object payload')
  }
  if (parsed.version !== 1) {
    throw corruptStoredData(source, `expected version 1 metadata manifest`)
  }
  if (
    typeof parsed.revision !== 'number' ||
    !Number.isInteger(parsed.revision) ||
    parsed.revision < 0
  ) {
    throw corruptStoredData(source, 'expected revision to be a non-negative integer')
  }
  return {
    version: 1,
    revision: parsed.revision,
    aliases: parseNumberMap(source, parsed.aliases, 'aliases', true),
    notes: parseStringMap(source, parsed.notes, 'notes'),
    scales: parseNumberMap(source, parsed.scales, 'scales', false),
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

async function readManifest(name: string): Promise<UserLibraryMetadataManifest> {
  const db = await dbReady()
  const row = await db
    .selectFrom('user_library_metadata')
    .select(['manifestJson'])
    .where('name', '=', name)
    .executeTakeFirst()
  if (!row) return emptyManifest()
  return parseUserLibraryMetadata(name, row.manifestJson)
}

async function writeManifest(name: string, manifest: UserLibraryMetadataManifest): Promise<void> {
  const db = await dbReady()
  const now = Date.now()
  const manifestJson = JSON.stringify(manifest)
  // Ensure the user_libraries parent row exists so the FK stays valid even if
  // metadata is set before the .excalidrawlib payload is uploaded.
  await db
    .insertInto('user_libraries')
    .values({ name, itemCount: null, createdAt: now, updatedAt: now })
    .onConflict((oc) => oc.column('name').doNothing())
    .execute()
  await db
    .insertInto('user_library_metadata')
    .values({ name, manifestJson, updatedAt: now })
    .onConflict((oc) => oc.column('name').doUpdateSet({ manifestJson, updatedAt: now }))
    .execute()
}

export async function getUserLibraryMetadata(name: string): Promise<UserLibraryMetadataManifest> {
  validateUserLibraryName(name)
  return readManifest(name)
}

export async function setUserLibraryMetadata(
  name: string,
  revision: number,
  patch: Partial<MetadataSetPatch>,
): Promise<UserLibraryMetadataManifest> {
  validateUserLibraryName(name)
  const current = await readManifest(name)
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
  await writeManifest(name, next)
  return next
}

export async function deleteUserLibraryMetadata(
  name: string,
  revision: number,
  patch: MetadataDeletePatch,
): Promise<UserLibraryMetadataManifest> {
  validateUserLibraryName(name)
  const current = await readManifest(name)
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
  await writeManifest(name, next)
  return next
}

export async function removeUserLibraryMetadata(name: string): Promise<void> {
  validateUserLibraryName(name)
  const db = await dbReady()
  await db.deleteFrom('user_library_metadata').where('name', '=', name).execute()
}
