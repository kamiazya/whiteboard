import { LoroDoc, encodeFrontiers, decodeFrontiers } from 'loro-crdt'
import type { Frontiers } from 'loro-crdt'
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { DATA_DIR } from '../config.js'
import {
  validateBranchName,
  validateSessionId,
  validateSlug,
  validateVersionId,
} from '../validators.js'
import { corruptStoredData, isCorruptStoredDataError, isMissingFileError } from './corrupt-stored-data.js'
import { assertPathWithinDir } from './path-guard.js'

// Loro-native versioning.
// Older code stored a per-version .loro snapshot, which duplicated storage and made restore
// semantics fuzzy. The main canvas .loro already contains the op-log, so a version only
// needs to persist the frontiers for that point in time.
//
// Storage:
//   DATA_DIR/{sessionId}/versions/{versionId}.json   metadata + base64 frontiers
//   DATA_DIR/{sessionId}/versions/{versionId}.png    optional thumbnail
//   per-version .loro snapshots are obsolete; any old files are ignored
//
// Loading forks the live doc from a snapshot, checks out the saved frontiers, and returns
// an independent past-state doc without touching the live cache entry.
//
// Restore is implemented in the route layer by diffing past vs current elements by id and
// writing the differences as new ops. CRDT history cannot be forgotten, so reverse ops are
// the only correct way to express a restore.

export const VERSIONS_DIRNAME = 'versions'

const MAX_AUTO_PER_CANVAS = 50
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

export { validateVersionId }

export interface OperatorInfo {
  kind: 'ai' | 'human' | 'system'
  peerId: string
  displayName?: string
  agentId?: string
  sessionId?: string
}

export interface VersionMeta {
  slug: string
  createdAt: string
  elementCount: number
  label?: string
  auto: boolean
  operator?: OperatorInfo
  // base64-encoded `encodeFrontiers(Frontiers)` bytes, decoded again during checkout.
  frontiers: string
  // Branch name associated with this commit. Legacy .json files hydrate to "main" when absent.
  branchName: string
}

export interface VersionEntry extends Omit<VersionMeta, 'frontiers'> {
  id: string
  hasThumbnail: boolean
  // frontiers stays internal; the API does not return it because the base64 bytes are bulky and unused by the UI.
  // load() uses the internal readMeta helper instead.
}

export interface VersionStore {
  save(
    sessionId: string,
    slug: string,
    doc: LoroDoc,
    opts: { auto: boolean; label?: string; branchName?: string; operator?: OperatorInfo },
  ): Promise<VersionEntry>
  // liveDoc is passed in so checkout can happen on a clone without affecting the live document.
  // Returns an independent past-state doc.
  load(sessionId: string, id: string, liveDoc: LoroDoc): Promise<LoroDoc | null>
  list(sessionId: string, slug: string): Promise<VersionEntry[]>
  saveThumbnail(sessionId: string, id: string, bytes: Uint8Array): Promise<void>
  loadThumbnail(sessionId: string, id: string): Promise<Uint8Array | null>
  // Return the frontiers referenced by the oldest retained version for this slug.
  // Return null when none exist, because compaction would otherwise risk losing all history.
  earliestFrontiers(sessionId: string, slug: string): Promise<Frontiers | null>
  // Public API used when creating branches from a version id.
  // Returns null only when the version is missing; corrupt metadata still throws.
  getFrontiersBase64(sessionId: string, id: string): Promise<string | null>
  // Rewrite branchName from oldName to newName for all versions of the given slug.
  // Returns the number of rewritten entries and does not touch other slugs.
  renameBranchInVersions(
    sessionId: string,
    slug: string,
    oldName: string,
    newName: string,
  ): Promise<number>
}

function versionsDir(sessionId: string): string {
  validateSessionId(sessionId)
  const dir = join(DATA_DIR, sessionId, VERSIONS_DIRNAME)
  return assertPathWithinDir(dir, DATA_DIR, 'session path')
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

function versionMetaPath(sessionId: string, id: string): string {
  validateVersionId(id)
  const dir = versionsDir(sessionId)
  const metaPath = join(dir, `${id}.json`)
  return assertPathWithinDir(metaPath, dir, 'version path')
}

function versionThumbnailPath(sessionId: string, id: string): string {
  validateVersionId(id)
  const dir = versionsDir(sessionId)
  const pngPath = join(dir, `${id}.png`)
  return assertPathWithinDir(pngPath, dir, 'version path')
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOperatorInfo(path: string, value: unknown): OperatorInfo {
  if (!isRecord(value)) {
    throw corruptStoredData(path, 'expected operator: object when present')
  }
  if (value.kind !== 'ai' && value.kind !== 'human' && value.kind !== 'system') {
    throw corruptStoredData(path, 'expected operator.kind: "ai" | "human" | "system"')
  }
  if (typeof value.peerId !== 'string' || value.peerId.trim().length === 0) {
    throw corruptStoredData(path, 'expected operator.peerId: non-empty string')
  }
  if (value.displayName !== undefined && typeof value.displayName !== 'string') {
    throw corruptStoredData(path, 'expected operator.displayName: string when present')
  }
  if (value.agentId !== undefined && typeof value.agentId !== 'string') {
    throw corruptStoredData(path, 'expected operator.agentId: string when present')
  }
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') {
    throw corruptStoredData(path, 'expected operator.sessionId: string when present')
  }

  return {
    kind: value.kind,
    peerId: value.peerId,
    ...(value.displayName !== undefined ? { displayName: value.displayName } : {}),
    ...(value.agentId !== undefined ? { agentId: value.agentId } : {}),
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
  }
}

async function unlinkIfPresent(path: string, detail: string) {
  try {
    await unlink(path)
    return null
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    return corruptStoredData(path, `${detail} (${errorMessage(error)})`)
  }
}

function logPruneErrors(scope: string, errors: Array<{ message: string }>): void {
  for (const error of errors) {
    console.error(`[${scope}] ${error.message}`)
  }
}

export async function pruneVersionArtifacts(
  dir: string,
  versionIds: string[],
): Promise<ReturnType<typeof corruptStoredData>[]> {
  const errors: ReturnType<typeof corruptStoredData>[] = []
  for (const id of versionIds) {
    for (const ext of ['.loro', '.json', '.png']) {
      const path = assertPathWithinDir(join(dir, `${id}${ext}`), dir, 'version path')
      const error = await unlinkIfPresent(path, 'failed to remove pruned version artifact')
      if (error) errors.push(error)
    }
  }
  return errors
}

function parseVersionMeta(path: string, raw: string): VersionMeta {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw corruptStoredData(path, `invalid JSON (${errorMessage(error)})`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corruptStoredData(path, 'expected version metadata object')
  }

  const data = parsed as Partial<VersionMeta>
  if (typeof data.slug !== 'string') {
    throw corruptStoredData(path, 'expected slug: string')
  }
  try {
    validateSlug(data.slug)
  } catch {
    throw corruptStoredData(path, 'expected valid slug')
  }
  if (typeof data.createdAt !== 'string') {
    throw corruptStoredData(path, 'expected createdAt: string')
  }
  if (typeof data.elementCount !== 'number' || !Number.isFinite(data.elementCount)) {
    throw corruptStoredData(path, 'expected elementCount: number')
  }
  if (data.label !== undefined && typeof data.label !== 'string') {
    throw corruptStoredData(path, 'expected label: string when present')
  }
  if (typeof data.auto !== 'boolean') {
    throw corruptStoredData(path, 'expected auto: boolean')
  }
  const operator =
    data.operator !== undefined ? parseOperatorInfo(path, data.operator) : undefined
  if (typeof data.frontiers !== 'string' || data.frontiers.length === 0) {
    throw corruptStoredData(path, 'expected frontiers: non-empty string')
  }
  const branchName = data.branchName ?? 'main'
  if (typeof branchName !== 'string') {
    throw corruptStoredData(path, 'expected branchName: string when present')
  }
  try {
    validateBranchName(branchName)
  } catch {
    throw corruptStoredData(path, 'expected valid branchName')
  }

  return {
    slug: data.slug,
    createdAt: data.createdAt,
    elementCount: data.elementCount,
    auto: data.auto,
    frontiers: data.frontiers,
    branchName,
    ...(data.label !== undefined ? { label: data.label } : {}),
    ...(operator !== undefined ? { operator } : {}),
  }
}

async function readMeta(sessionId: string, id: string): Promise<VersionMeta | null> {
  const metaPath = versionMetaPath(sessionId, id)
  try {
    const raw = await readFile(metaPath, 'utf-8')
    return parseVersionMeta(metaPath, raw)
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    if (isCorruptStoredDataError(error)) {
      throw error
    }
    throw corruptStoredData(metaPath, `failed to read version metadata (${errorMessage(error)})`)
  }
}

export class FileVersionStore implements VersionStore {
  async save(
    sessionId: string,
    slug: string,
    doc: LoroDoc,
    opts: { auto: boolean; label?: string; branchName?: string; operator?: OperatorInfo },
  ): Promise<VersionEntry> {
    const id = nanoid(12)
    validateVersionId(id)

    const dir = versionsDir(sessionId)
    await mkdir(dir, { recursive: true })

    const metaPath = join(dir, `${id}.json`)
    assertPathWithinDir(metaPath, dir, 'version path')

    const elementCount = (() => {
      try {
        const list = doc.getMovableList('elements').toJSON() as Array<{ isDeleted?: boolean }>
        return list.filter((e) => !e.isDeleted).length
      } catch {
        return 0
      }
    })()

    const frontiersBytes = encodeFrontiers(doc.frontiers())

    const meta: VersionMeta = {
      slug,
      createdAt: new Date().toISOString(),
      elementCount,
      auto: opts.auto,
      ...(opts.operator !== undefined ? { operator: parseOperatorInfo(metaPath, opts.operator) } : {}),
      frontiers: bytesToBase64(frontiersBytes),
      branchName: opts.branchName ?? 'main',
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    }

    await writeFile(metaPath, JSON.stringify(meta, null, 2))
    await this.prune(sessionId, slug)
    return { id, hasThumbnail: false, ...stripFrontiers(meta) }
  }

  async load(sessionId: string, id: string, liveDoc: LoroDoc): Promise<LoroDoc | null> {
    const meta = await readMeta(sessionId, id)
    if (!meta) return null
    const metaPath = versionMetaPath(sessionId, id)
    // Fork the live doc through a snapshot so checkout does not affect the live attached document.
    const clone = LoroDoc.fromSnapshot(liveDoc.export({ mode: 'snapshot' }))
    try {
      const frontiers = decodeFrontiers(base64ToBytes(meta.frontiers))
      clone.checkout(frontiers)
    } catch (error) {
      throw corruptStoredData(
        metaPath,
        `frontiers could not be checked out against the live document (${errorMessage(error)})`,
      )
    }
    // clone stays in detached mode. Read operations such as toJSON reflect the past state,
    // while edits such as commit or insert are not allowed. That is sufficient because
    // callers only need to read past elements; restore writes reverse ops to the live doc.
    //
    // Do not rebuild this clone through export({mode:'snapshot'}) + fromSnapshot because
    // that would reattach it and lose the checked-out past state.
    return clone
  }

  async list(sessionId: string, slug: string): Promise<VersionEntry[]> {
    const dir = versionsDir(sessionId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (isMissingFileError(error)) {
        return []
      }
      throw corruptStoredData(dir, `failed to read versions directory (${errorMessage(error)})`)
    }
    const metaFiles = entries.filter((f) => f.endsWith('.json'))
    const pngSet = new Set(
      entries.filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')),
    )
    const results: VersionEntry[] = []
    for (const f of metaFiles) {
      const metaPath = assertPathWithinDir(join(dir, f), dir, 'version path')
      let raw: string
      try {
        raw = await readFile(metaPath, 'utf-8')
      } catch (error) {
        throw corruptStoredData(metaPath, `failed to read version metadata (${errorMessage(error)})`)
      }
      const meta = parseVersionMeta(metaPath, raw)
      if (meta.slug !== slug) continue
      const id = f.replace(/\.json$/, '')
      results.push({ id, hasThumbnail: pngSet.has(id), ...stripFrontiers(meta) })
    }
    results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return results
  }

  async saveThumbnail(sessionId: string, id: string, bytes: Uint8Array): Promise<void> {
    validateVersionId(id)
    if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
      throw new Error(
        `Thumbnail exceeds ${MAX_THUMBNAIL_BYTES} byte limit (${bytes.byteLength})`,
      )
    }
    const dir = versionsDir(sessionId)
    await mkdir(dir, { recursive: true })
    const pngPath = join(dir, `${id}.png`)
    assertPathWithinDir(pngPath, dir, 'version path')
    await writeFile(pngPath, bytes)
  }

  async loadThumbnail(sessionId: string, id: string): Promise<Uint8Array | null> {
    const pngPath = versionThumbnailPath(sessionId, id)
    try {
      const bytes = await readFile(pngPath)
      return new Uint8Array(bytes)
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }
      throw corruptStoredData(pngPath, `failed to read version thumbnail (${errorMessage(error)})`)
    }
  }

  async renameBranchInVersions(
    sessionId: string,
    slug: string,
    oldName: string,
    newName: string,
  ): Promise<number> {
    if (oldName === newName) return 0
    const dir = versionsDir(sessionId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (isMissingFileError(error)) {
        return 0
      }
      throw corruptStoredData(dir, `failed to read versions directory (${errorMessage(error)})`)
    }
    const metaFiles = entries.filter((f) => f.endsWith('.json'))
    let renamed = 0
    for (const f of metaFiles) {
      const metaPath = assertPathWithinDir(join(dir, f), dir, 'version path')
      let raw: string
      try {
        raw = await readFile(metaPath, 'utf-8')
      } catch (error) {
        throw corruptStoredData(metaPath, `failed to read version metadata (${errorMessage(error)})`)
      }
      const meta = parseVersionMeta(metaPath, raw)
      if (meta.slug !== slug) continue
      const current = meta.branchName
      if (current !== oldName) continue
      const next: VersionMeta = { ...meta, branchName: newName }
      await writeFile(metaPath, JSON.stringify(next, null, 2))
      renamed += 1
    }
    return renamed
  }

  async getFrontiersBase64(sessionId: string, id: string): Promise<string | null> {
    const meta = await readMeta(sessionId, id)
    return meta?.frontiers ?? null
  }

  async earliestFrontiers(sessionId: string, slug: string): Promise<Frontiers | null> {
    const dir = versionsDir(sessionId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }
      throw corruptStoredData(dir, `failed to read versions directory (${errorMessage(error)})`)
    }
    const metaFiles = entries.filter((f) => f.endsWith('.json'))
    let oldest: { path: string; createdAt: string; frontiers: string } | null = null
    for (const f of metaFiles) {
      const metaPath = assertPathWithinDir(join(dir, f), dir, 'version path')
      let raw: string
      try {
        raw = await readFile(metaPath, 'utf-8')
      } catch (error) {
        throw corruptStoredData(metaPath, `failed to read version metadata (${errorMessage(error)})`)
      }
      const meta = parseVersionMeta(metaPath, raw)
      if (meta.slug !== slug) continue
      if (!oldest || meta.createdAt < oldest.createdAt) {
        oldest = { path: metaPath, createdAt: meta.createdAt, frontiers: meta.frontiers }
      }
    }
    if (!oldest) return null
    try {
      return decodeFrontiers(base64ToBytes(oldest.frontiers))
    } catch (error) {
      throw corruptStoredData(
        oldest.path,
        `frontiers could not be decoded (${errorMessage(error)})`,
      )
    }
  }

  private async prune(sessionId: string, slug: string): Promise<void> {
    const dir = versionsDir(sessionId)
    try {
      const all = await this.list(sessionId, slug)
      const autos = all.filter((v) => v.auto)
      if (autos.length <= MAX_AUTO_PER_CANVAS) return
      const toRemove = autos.slice(MAX_AUTO_PER_CANVAS)
      const errors = await pruneVersionArtifacts(
        dir,
        toRemove.map((entry) => entry.id),
      )
      logPruneErrors('version-store prune', errors)
    } catch (error) {
      const issue = isCorruptStoredDataError(error)
        ? error
        : corruptStoredData(dir, `failed to prune versions (${errorMessage(error)})`)
      logPruneErrors('version-store prune', [issue])
    }
  }
}

// Internal helper: strip frontiers from VersionMeta to produce the VersionEntry shape.
function stripFrontiers(meta: VersionMeta): Omit<VersionMeta, 'frontiers'> {
  const { frontiers: _f, ...rest } = meta
  return rest
}
