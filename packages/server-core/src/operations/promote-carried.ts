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
  resolveWorkspaceDocumentById,
  statedKindSplit,
  stateElementCount,
} from '@kamiazya/whiteboard-loro-adapter'
import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import type { BlobStore } from '@kamiazya/whiteboard-ports'
import { decodeFrontiers, type LoroDoc } from 'loro-crdt'
import type { AdoptedVersion } from '../server-deps.js'
import {
  PROMOTE_MAX_JUDGED_ELEMENTS,
  PROMOTE_MAX_TRASH,
  PROMOTE_MAX_VERSIONS,
  type PromotedTrashBytes,
  type PromotedVersion,
} from '../versions/version-entry.js'
import { DocumentKindChangedError, textBreachRefusal } from './sync-write-refusals.js'

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
  /** Judging the carried versions would project more than one promotion is allowed; nothing merged. */
  | { readonly kind: 'over-budget'; readonly limit: number }
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
 *
 * `charge` is told the projection's size BEFORE the size judgement, the
 * dearer half, and answers whether the budget still holds it.
 */
function judgeDocumentAt(
  past: LoroDoc,
  version: Pick<CarriedVersion, 'id' | 'documentId'>,
  charge: (elements: number) => boolean,
): PointJudgement | { readonly reason: string } | 'over-budget' {
  const content = projectWorkspaceDocument(past, version.documentId)
  if (content === null) {
    return {
      reason: `Version "${version.id}" names a document the record did not hold at that point.`,
    }
  }
  if (!charge(stateElementCount(content))) return 'over-budget'
  const breach = judgeStateWithinTextLimits(content)
  if (breach !== null) {
    const at = readWorkspaceDocuments(past).find((entry) => entry.documentId === version.documentId)
    throw textBreachRefusal(breach, at === undefined ? undefined : { path: at.path })
  }
  // A restore writes the envelope back, so one stating another kind than its
  // node records at that point would bring the split with it.
  const recorded = resolveWorkspaceDocumentById(past, version.documentId)?.kind
  const split = statedKindSplit(content, recorded)
  if (split !== null) {
    throw new DocumentKindChangedError(split.recorded, split.kind, version.documentId)
  }
  return {
    elementCount: countSpatialNodes(content),
    contentDigest: contentDigestOfDocument(content),
  }
}

/** A carried row with its point decoded, and where that point sits in the record's history. */
interface PlacedRow {
  readonly index: number
  readonly version: Omit<CarriedVersion, 'frontiers'>
  readonly decoded: ReturnType<typeof decodeFrontiers>
  readonly point: string
  /** Ops the record holds up to the point: a linear extension of causal order. */
  readonly position: number
}

/**
 * Each row's point, decoded and placed, in the caller's order — so the row
 * a refusal names is the first unheld one the caller sent.
 */
function placeRows(
  incoming: LoroDoc,
  versions: readonly CarriedVersion[],
): { readonly id: string } | readonly PlacedRow[] {
  const positions = new Map<string, number>()
  const placed: PlacedRow[] = []
  for (const [index, { frontiers, ...version }] of versions.entries()) {
    const decoded = decodedPoint(frontiers)
    if (decoded === undefined) return { id: version.id }
    const point = pointKey(decoded)
    let position = positions.get(point)
    if (position === undefined) {
      try {
        position = 0
        for (const count of incoming.frontiersToVV(decoded).toJSON().values()) position += count
      } catch {
        return { id: version.id }
      }
      positions.set(point, position)
    }
    placed.push({ index, version, decoded, point, position })
  }
  return placed
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
 * A document at a point is judged once, however many rows name it, and rows
 * are judged in history order, so the fork crosses the history once however
 * the caller ordered them; the answer keeps the caller's order. Every
 * distinct judgement is charged to `budget`, in elements projected, so rows
 * naming distinct points cannot buy a projection each without bound.
 */
function judgeVersions(
  incoming: LoroDoc,
  versions: readonly CarriedVersion[],
  budget: number,
): { readonly reason: string } | 'over-budget' | { readonly rows: AdoptedVersion[] } {
  if (versions.length === 0) return { rows: [] }
  const unheld = (id: string) => ({
    reason: `Version "${id}" names a point the record does not hold.`,
  })
  const placed = placeRows(incoming, versions)
  if ('id' in placed) return unheld(placed.id)
  const ordered = [...placed].sort(
    (a, b) => a.position - b.position || compareCodeUnit(a.point, b.point) || a.index - b.index,
  )
  const reader = pastReader(incoming)
  const judged = new Map<string, PointJudgement>()
  const rows: AdoptedVersion[] = new Array(versions.length)
  let spent = 0
  const charge = (elements: number): boolean => {
    spent += elements
    return spent <= budget
  }
  for (const { index, version, decoded, point } of ordered) {
    const key = `${point}\u0000${version.documentId}`
    let judgement = judged.get(key)
    if (judgement === undefined) {
      if (!reader.moveTo(point, decoded)) return unheld(version.id)
      const answer = judgeDocumentAt(reader.past, version, charge)
      if (answer === 'over-budget' || 'reason' in answer) return answer
      judgement = answer
      judged.set(key, judgement)
    }
    rows[index] = { ...version, frontiers: decoded, ...judgement }
  }
  return { rows }
}

export async function judgeCarried(
  incoming: LoroDoc,
  carried: {
    readonly trash: readonly CarriedTrashBytes[]
    readonly versions: readonly CarriedVersion[]
  },
  /** Elements the version judgements may project; a parameter so a test can reach it cheaply. */
  budget: number = PROMOTE_MAX_JUDGED_ELEMENTS,
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
  const versions = judgeVersions(incoming, carried.versions, budget)
  if (versions === 'over-budget') return { kind: 'over-budget', limit: budget }
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
