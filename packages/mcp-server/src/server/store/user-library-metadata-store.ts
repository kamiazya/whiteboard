import {
  type UserLibraryMetadataManifest,
  userLibraryMetadataManifestSchema,
} from '../../shared/api-contracts/libraries.js'
import { DATA_DIR } from '../config.js'
import { validateUserLibraryName } from '../validators.js'
import { corruptStoredData } from './corrupt-stored-data.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'

export const USER_LIBRARY_METADATA_FILENAME_SUFFIX = '.meta.json'

export type { UserLibraryMetadataManifest }

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

function parseUserLibraryMetadata(name: string, raw: string): UserLibraryMetadataManifest {
  const source = `user_library_metadata/${name}`
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw corruptStoredData(source, 'expected valid user library metadata JSON')
  }
  const result = userLibraryMetadataManifestSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'manifest'
    throw corruptStoredData(source, `${where}: ${issue?.message ?? 'invalid metadata manifest'}`)
  }
  return result.data
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
