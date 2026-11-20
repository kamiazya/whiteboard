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
import type {
  RecordSession,
  RecordView,
  readTrashEntries,
  SyncTextBreach,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64, compareCodeUnit, type DocumentKind } from '@kamiazya/whiteboard-model'
import type { BlobStore } from '@kamiazya/whiteboard-ports'
import type { AdoptedVersion } from '../server-deps.js'
import {
  PROMOTE_MAX_JUDGED_SIZE,
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

// The engine answers in the shapes the loro-adapter readers return; this
// package asserts the type and holds no schema of its own for it.
const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

type TrashEntries = ReturnType<typeof readTrashEntries>

/**
 * Bytes are admitted only under the digest the record's own entry names, so
 * a carried blob can bring back exactly the document that was deleted and
 * never stand in for another.
 */
async function judgeTrash(
  incoming: RecordSession,
  trash: readonly CarriedTrashBytes[],
): Promise<string | null> {
  const held = await incoming.read({ query: 'trash' }, assertedAs<TrashEntries>())
  const entries = new Map(held.map((entry) => [entry.documentId, entry]))
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

/** What judging one document at one point answers, which every row naming both shares. */
type PointJudgement = Pick<AdoptedVersion, 'elementCount' | 'contentDigest'>

/** One view of the incoming record, moved only when asked for a point it is not already at. */
function pastReader(incoming: RecordSession) {
  let view: RecordView | undefined
  let at: string | undefined
  return {
    /** Whether the record holds `point`; the view is at it when it does. */
    moveTo(point: string, frontiers: Uint8Array): boolean {
      if (at === point) return true
      try {
        if (view === undefined) view = incoming.view(frontiers)
        else view.moveTo(frontiers)
      } catch {
        return false
      }
      at = point
      return true
    },
    read: <T>(query: Parameters<RecordView['read']>[0], shape: { parse(value: unknown): T }) => {
      if (view === undefined) throw new TypeError('the view is at no point yet')
      return view.read(query, shape)
    },
    release() {
      view?.release()
    },
  }
}

/** The index row one document has in the record, as the node records it. */
interface PastEntry {
  readonly path: string
  readonly kind: DocumentKind
}

/**
 * The document a row names, judged as the sync surface would judge it
 * written whole at the point `past` is at: a state past a limit is thrown as
 * the same `TextBreachRefusalError` the merge raises, naming the document.
 *
 * `charge` is told the projection's size BEFORE the size judgement, the
 * dearer half, and answers whether the budget still holds it.
 */
async function judgeDocumentAt(
  past: ReturnType<typeof pastReader>,
  version: Pick<CarriedVersion, 'id' | 'documentId'>,
  charge: (size: number) => boolean,
): Promise<PointJudgement | { readonly reason: string } | 'over-budget'> {
  const { documentId } = version
  const at = { args: { documentId } }
  const entry = await past.read(
    { query: 'workspaceDocumentEntry', ...at },
    assertedAs<PastEntry | null>(),
  )
  if (entry === null) {
    return {
      reason: `Version "${version.id}" names a document the record did not hold at that point.`,
    }
  }
  if (!charge(await past.read({ query: 'stateSize', ...at }, assertedAs<number>()))) {
    return 'over-budget'
  }
  const breach = await past.read(
    { query: 'textLimitBreach', ...at },
    assertedAs<SyncTextBreach | null>(),
  )
  if (breach !== null) throw textBreachRefusal(breach, { path: entry.path })
  // A restore writes the envelope back, so one stating another kind than its
  // node records at that point would bring the split with it.
  const stated = await past.read(
    { query: 'documentKind', ...at },
    assertedAs<DocumentKind | undefined>(),
  )
  if (stated !== undefined && stated !== entry.kind) {
    throw new DocumentKindChangedError(entry.kind, stated, documentId)
  }
  return {
    elementCount: await past.read({ query: 'spatialNodeCount', ...at }, assertedAs<number>()),
    contentDigest: await past.read({ query: 'contentDigest', ...at }, assertedAs<string>()),
  }
}

/** How long version judging runs before handing the loop back. */
const JUDGE_SLICE_MS = 10

/**
 * A turn of the loop for whatever else is waiting. A timer rather than
 * `setImmediate`, which this runtime-neutral package cannot assume.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** A carried row with its point placed in the record's history. */
interface PlacedRow {
  readonly index: number
  readonly version: CarriedVersion
  /** The point in one spelling, whatever order or form its bytes listed it in. */
  readonly point: string
  /** Ops the record holds up to the point: a linear extension of causal order. */
  readonly position: number
}

/**
 * Each row's point, placed in the caller's order — so the row a refusal names
 * is the first unheld one the caller sent. The record itself says what a
 * point is (`versionAt`): bytes that are no frontier and a point it does not
 * hold are both "not held".
 */
function placeRows(
  incoming: RecordSession,
  versions: readonly CarriedVersion[],
): { readonly id: string } | readonly PlacedRow[] {
  const placed = new Map<string, { point: string; position: number }>()
  const rows: PlacedRow[] = []
  for (const [index, version] of versions.entries()) {
    const spelled = bytesToBase64(version.frontiers)
    let at = placed.get(spelled)
    if (at === undefined) {
      try {
        const held = incoming.versionAt(version.frontiers)
        at = {
          point: bytesToBase64(held.encodedFrontiers),
          position: held.entries.reduce((sum, { counter }) => sum + counter, 0),
        }
      } catch {
        return { id: version.id }
      }
      placed.set(spelled, at)
    }
    rows.push({ index, version, ...at })
  }
  return rows
}

/**
 * Each frontier checked out of ONE view of the incoming record — a view
 * copies the whole workspace, a checkout moves the one it has. The count and
 * digest come from that state, so a row cannot describe content it does not
 * point at.
 *
 * The merge judges the record's head only, and a restore writes a version's
 * state back as it stands, so each state is also judged here as the sync
 * surface would judge it written whole (`judgeDocumentAt`).
 *
 * A document at a point is judged once, however many rows name it, and rows
 * are judged in history order, so the view crosses the history once however
 * the caller ordered them; the answer keeps the caller's order. Every
 * distinct judgement is charged to `budget`, in `stateSize` of each projection, so rows
 * naming distinct points cannot buy a projection each without bound.
 *
 * Within the budget a move may still hold hundreds of judgements, so the loop
 * is handed back once a slice of `JUDGE_SLICE_MS` has been spent: the stall
 * another request waits behind is one judgement, not the move. Nothing shared
 * is read across the yield — the view is this call's own, and `incoming` is
 * the request's record, merged only after this returns.
 */
async function judgeVersions(
  incoming: RecordSession,
  versions: readonly CarriedVersion[],
  budget: number,
): Promise<{ readonly reason: string } | 'over-budget' | { readonly rows: AdoptedVersion[] }> {
  if (versions.length === 0) return { rows: [] }
  const placed = placeRows(incoming, versions)
  if ('id' in placed) return unheld(placed.id)
  const ordered = [...placed].sort(
    (a, b) => a.position - b.position || compareCodeUnit(a.point, b.point) || a.index - b.index,
  )
  const reader = pastReader(incoming)
  try {
    return await judgeInOrder(reader, ordered, budget)
  } finally {
    reader.release()
  }
}

const unheld = (id: string) => ({
  reason: `Version "${id}" names a point the record does not hold.`,
})

/** The placed rows judged in the order given, each distinct (point, document) once, charged to `budget`. */
async function judgeInOrder(
  reader: ReturnType<typeof pastReader>,
  ordered: readonly PlacedRow[],
  budget: number,
): Promise<{ readonly reason: string } | 'over-budget' | { readonly rows: AdoptedVersion[] }> {
  const judged = new Map<string, PointJudgement>()
  const rows: AdoptedVersion[] = new Array(ordered.length)
  let spent = 0
  const charge = (size: number): boolean => {
    spent += size
    return spent <= budget
  }
  let sliceStarted = Date.now()
  for (const { index, version, point } of ordered) {
    const key = `${point}\u0000${version.documentId}`
    let judgement = judged.get(key)
    if (judgement === undefined) {
      if (Date.now() - sliceStarted >= JUDGE_SLICE_MS) {
        await yieldToLoop()
        sliceStarted = Date.now()
      }
      if (!reader.moveTo(point, version.frontiers)) return unheld(version.id)
      const answer = await judgeDocumentAt(reader, version, charge)
      if (answer === 'over-budget' || 'reason' in answer) return answer
      judgement = answer
      judged.set(key, judgement)
    }
    rows[index] = { ...version, ...judgement }
  }
  return { rows }
}

export async function judgeCarried(
  incoming: RecordSession,
  carried: {
    readonly trash: readonly CarriedTrashBytes[]
    readonly versions: readonly CarriedVersion[]
  },
  /** The `stateSize` the version judgements may charge; a parameter so a test can reach it cheaply. */
  budget: number = PROMOTE_MAX_JUDGED_SIZE,
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
  const versions = await judgeVersions(incoming, carried.versions, budget)
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
  merged: RecordSession,
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
  for (const entry of await merged.read({ query: 'trash' }, assertedAs<TrashEntries>())) {
    if (!carriedIds.has(entry.documentId)) continue
    if ((await blobs.has({ ref: entry.blob })).exists) stored.push(entry.documentId)
  }
  return stored
}
