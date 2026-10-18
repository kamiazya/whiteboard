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
import type { PromotedTrashBytes, PromotedVersion } from '../versions/version-entry.js'
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

/**
 * Each frontier checked out of ONE fork of the incoming record — a fork
 * copies the whole workspace, a checkout moves the one it has. The count and
 * digest come from that state, so a row cannot describe content it does not
 * point at.
 *
 * The merge judges the record's head only, and a restore writes a version's
 * state back as it stands, so each state is also judged here as the sync
 * surface would judge it written whole: a version past a limit is refused,
 * thrown as the same `TextBreachRefusalError` the merge raises, naming the
 * document.
 */
function judgeVersions(
  incoming: LoroDoc,
  versions: readonly CarriedVersion[],
): { readonly reason: string } | { readonly rows: AdoptedVersion[] } {
  if (versions.length === 0) return { rows: [] }
  const past = incoming.fork()
  const rows: AdoptedVersion[] = []
  for (const { frontiers, ...version } of versions) {
    let decoded: ReturnType<typeof decodeFrontiers>
    try {
      decoded = decodeFrontiers(frontiers)
      past.checkout(decoded)
    } catch {
      return { reason: `Version "${version.id}" names a point the record does not hold.` }
    }
    const content = projectWorkspaceDocument(past, version.documentId)
    if (content === null) {
      return {
        reason: `Version "${version.id}" names a document the record did not hold at that point.`,
      }
    }
    const breach = judgeStateWithinTextLimits(content)
    if (breach !== null) {
      const at = readWorkspaceDocuments(past).find(
        (entry) => entry.documentId === version.documentId,
      )
      throw textBreachRefusal(breach, at === undefined ? undefined : { path: at.path })
    }
    rows.push({
      ...version,
      frontiers: decoded,
      elementCount: countSpatialNodes(content),
      contentDigest: contentDigestOfDocument(content),
    })
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
