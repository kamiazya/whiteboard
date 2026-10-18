/**
 * What a promotion carries BESIDE the record: the planes the record only
 * points at. A trash entry names its evacuated bytes by digest, and a saved
 * version is a frontier of the record — both live outside the snapshot, so a
 * move that sent the snapshot alone listed trash it could not restore and
 * left every saved version behind.
 *
 * Judged against the INCOMING record before anything merges, so a refusal
 * keeps nothing; written after the merge, and read back, so the answer says
 * what the daemon holds rather than what was asked for.
 */
import {
  contentDigestOfDocument,
  countSpatialNodes,
  judgeStateWithinTextLimits,
  projectWorkspaceDocument,
  readTrashEntries,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import type { BlobStore } from '@kamiazya/whiteboard-ports'
import { decodeFrontiers, type LoroDoc } from 'loro-crdt'
import type { AdoptedVersion } from '../server-deps.js'
import {
  PROMOTE_MAX_TRASH,
  PROMOTE_MAX_VERSIONS,
  type PromotedTrashBytes,
  type PromotedVersion,
} from '../versions/version-entry.js'
import { textBreachRefusal } from './sync-write-refusals.js'

/** One trash entry's evacuated bytes, decoded. */
export type CarriedTrashBytes = Readonly<
  Omit<PromotedTrashBytes, 'bytes'> & { readonly bytes: Uint8Array }
>

/** One saved version as the other keeper recorded it, its frontier decoded from base64url only. */
export type CarriedVersion = Readonly<
  Omit<PromotedVersion, 'frontiers'> & { readonly frontiers: Uint8Array }
>

export type CarriedJudgement =
  | { readonly kind: 'refused'; readonly reason: string }
  /** More rows of one plane than a promotion carries; none of them was judged. */
  | {
      readonly kind: 'too-many'
      readonly plane: 'trash' | 'versions'
      readonly carried: number
      readonly limit: number
    }
  | {
      readonly kind: 'admitted'
      readonly trash: readonly CarriedTrashBytes[]
      readonly versions: readonly AdoptedVersion[]
    }

/**
 * Web Crypto rather than `node:crypto`: this package runs unchanged on Node,
 * the browser and a worker. The copy gives `digest` the plain buffer it types.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Bytes are admitted only under the digest the record's own entry names, so
 * a carried blob can bring back exactly the document that was deleted and
 * never stand in for another.
 */
async function judgeTrash(
  incoming: LoroDoc,
  trash: readonly CarriedTrashBytes[],
): Promise<string | null> {
  const entries = new Map(readTrashEntries(incoming).map((entry) => [entry.documentId, entry]))
  for (const carried of trash) {
    const entry = entries.get(carried.documentId)
    if (entry === undefined) {
      return `No trash entry in the record is for document "${carried.documentId}".`
    }
    if ((await sha256Hex(carried.bytes)) !== entry.blob.digestHex) {
      return `The bytes carried for trashed document "${carried.documentId}" are not the ones its trash entry names.`
    }
  }
  return null
}

/** One spelling per point: a frontier's ids in a fixed order, whatever order its bytes listed them in. */
function pointKey(frontiers: ReturnType<typeof decodeFrontiers>): string {
  return frontiers
    .map(({ peer, counter }) => `${peer}:${counter}`)
    .sort()
    .join(',')
}

/** What judging one document at one point answers, which every row naming both shares. */
type PointJudgement = Pick<AdoptedVersion, 'elementCount' | 'contentDigest'>

/** The frontier a row names, or `undefined` for bytes that are not one. */
function decodedPoint(frontiers: Uint8Array): ReturnType<typeof decodeFrontiers> | undefined {
  try {
    return decodeFrontiers(frontiers)
  } catch {
    return undefined
  }
}

/** One fork of the incoming record, moved only when asked for a point it is not already at. */
function pastReader(incoming: LoroDoc) {
  const past = incoming.fork()
  let at: string | undefined
  return {
    past,
    /** Whether the record holds `point`; the fork is at it when it does. */
    moveTo(point: string, frontiers: ReturnType<typeof decodeFrontiers>): boolean {
      if (at === point) return true
      try {
        past.checkout(frontiers)
      } catch {
        return false
      }
      at = point
      return true
    },
  }
}

/**
 * The document a row names, judged as the sync surface would judge it
 * written whole at the point `past` is checked out at: a state past a limit
 * is thrown as the same `TextBreachRefusalError` the merge raises, naming
 * the document.
 */
function judgeDocumentAt(
  past: LoroDoc,
  version: Pick<CarriedVersion, 'id' | 'documentId'>,
): PointJudgement | { readonly reason: string } {
  const content = projectWorkspaceDocument(past, version.documentId)
  if (content === null) {
    return {
      reason: `Version "${version.id}" names a document the record did not hold at that point.`,
    }
  }
  const breach = judgeStateWithinTextLimits(content)
  if (breach !== null) {
    const at = readWorkspaceDocuments(past).find((entry) => entry.documentId === version.documentId)
    throw textBreachRefusal(breach, at === undefined ? undefined : { path: at.path })
  }
  return {
    elementCount: countSpatialNodes(content),
    contentDigest: contentDigestOfDocument(content),
  }
}

/**
 * Each frontier checked out of ONE fork of the incoming record — a fork
 * copies the whole workspace, a checkout moves the one it has. The count and
 * digest come from that state, so a row cannot describe content it does not
 * point at.
 *
 * The merge judges the record's head only, and a restore writes a version's
 * state back as it stands, so each state is also judged here as the sync
 * surface would judge it written whole (`judgeDocumentAt`).
 *
 * A document at a point is judged once, however many rows name it, and the
 * fork moves only when a row names another point: rows repeating one point
 * cost a lookup each rather than a projection.
 */
function judgeVersions(
  incoming: LoroDoc,
  versions: readonly CarriedVersion[],
): { readonly reason: string } | { readonly rows: AdoptedVersion[] } {
  if (versions.length === 0) return { rows: [] }
  const reader = pastReader(incoming)
  const judged = new Map<string, PointJudgement>()
  const rows: AdoptedVersion[] = []
  const unheld = (id: string) => ({
    reason: `Version "${id}" names a point the record does not hold.`,
  })
  for (const { frontiers, ...version } of versions) {
    const decoded = decodedPoint(frontiers)
    if (decoded === undefined) return unheld(version.id)
    const point = pointKey(decoded)
    const key = `${point}\u0000${version.documentId}`
    let judgement = judged.get(key)
    if (judgement === undefined) {
      if (!reader.moveTo(point, decoded)) return unheld(version.id)
      const answer = judgeDocumentAt(reader.past, version)
      if ('reason' in answer) return answer
      judgement = answer
      judged.set(key, judgement)
    }
    rows.push({ ...version, frontiers: decoded, ...judgement })
  }
  return { rows }
}

export async function judgeCarried(
  incoming: LoroDoc,
  carried: {
    readonly trash: readonly CarriedTrashBytes[]
    readonly versions: readonly CarriedVersion[]
  },
): Promise<CarriedJudgement> {
  // Counted before any row is judged, so past either cap nothing is.
  if (carried.versions.length > PROMOTE_MAX_VERSIONS) {
    return {
      kind: 'too-many',
      plane: 'versions',
      carried: carried.versions.length,
      limit: PROMOTE_MAX_VERSIONS,
    }
  }
  if (carried.trash.length > PROMOTE_MAX_TRASH) {
    return {
      kind: 'too-many',
      plane: 'trash',
      carried: carried.trash.length,
      limit: PROMOTE_MAX_TRASH,
    }
  }
  const trashRefusal = await judgeTrash(incoming, carried.trash)
  if (trashRefusal !== null) return { kind: 'refused', reason: trashRefusal }
  const versions = judgeVersions(incoming, carried.versions)
  if ('reason' in versions) return { kind: 'refused', reason: versions.reason }
  return { kind: 'admitted', trash: carried.trash, versions: versions.rows }
}

/**
 * Stores each entry's bytes and answers the entries the MERGED record names
 * under a digest the blob store now holds — what a trash restore will find.
 */
export async function storeCarriedTrash(
  blobs: BlobStore,
  merged: LoroDoc,
  trash: readonly CarriedTrashBytes[],
): Promise<string[]> {
  for (const carried of trash) {
    await blobs.put({
      bytes: new Uint8Array(carried.bytes),
      contentType: 'application/octet-stream',
    })
  }
  const carriedIds = new Set(trash.map((carried) => carried.documentId))
  const stored: string[] = []
  for (const entry of readTrashEntries(merged)) {
    if (!carriedIds.has(entry.documentId)) continue
    if ((await blobs.has({ ref: entry.blob })).exists) stored.push(entry.documentId)
  }
  return stored
}
