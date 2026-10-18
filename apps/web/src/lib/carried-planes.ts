/**
 * What a workspace move carries BESIDE its record: each trash entry's
 * evacuated bytes and the saved version rows. The record only points at both
 * — a trash entry names its bytes by digest, a version is a frontier — so a
 * move that sent the snapshot alone would list trash the other keeper cannot
 * restore and leave every saved version behind.
 *
 * One reader and one fitting for every way a workspace moves: the promote to
 * the daemon (`promote-workspace.ts`) and the cross-origin transfer
 * (`transfer-payload.ts`, `accept-transferred-record.ts`) send the same planes
 * under the same body ceiling and say afterwards, in the same words, what did
 * not go.
 *
 * Loaded lazily by every caller, like the modules above: it reaches loro.
 */
import {
  PROMOTE_MAX_TRASH,
  PROMOTE_MAX_VERSIONS,
  PROMOTE_REQUEST_LIMIT_BYTES,
  type PromotedTrashBytes,
  type PromotedVersion,
  type PromoteWorkspaceRequest,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  readTrashEntries,
  readWorkspaceDocuments,
  scanFileReferences,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url, fitToLength, VERSION_LABEL_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { savedVersionReads, savedVersionRows, type VersionRow } from './browser-version-store.js'
import { countOf, planeCounts } from './count-wording.js'
import { IdbBlobStore } from './idb-blob-store.js'

type FileReferenceScan = Awaited<ReturnType<typeof scanFileReferences>>

/** What travels beside the record, and what is left behind with a reason. */
export interface CarriedPlanes {
  readonly trash: readonly PromotedTrashBytes[]
  readonly versions: readonly PromotedVersion[]
  /** Each carried trash entry's path, so what does not fit can be named. */
  readonly trashPaths: ReadonlyMap<string, string>
  readonly leftBehind: readonly string[]
  /** The scan the planes were judged by — the images a move must also carry. */
  readonly scan: FileReferenceScan
}

/**
 * A stored label as the wire takes it. A row is read leniently — labels
 * written before the input was bounded still parse — but the promote body is
 * strict, so one over-long label would refuse the whole move. Shortened
 * rather than left behind: a version held back keeps the browser copy, and a
 * label is not worth that.
 */
function wireLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  const fitted = fitToLength(label, VERSION_LABEL_MAX_LENGTH)
  return fitted === '' ? undefined : fitted
}

/** The wire form of a version row: no device, which only a keeper can back with a key. */
function promotedVersion(row: VersionRow): PromotedVersion {
  let operator: PromotedVersion['operator']
  if (row.operator !== undefined) {
    const { actor: _device, ...stated } = row.operator
    operator = stated
  }
  const label = wireLabel(row.label)
  return {
    id: row.id,
    documentId: row.documentId,
    createdAt: Math.trunc(row.createdAt),
    auto: row.auto === true,
    ...(label === undefined ? {} : { label }),
    ...(operator === undefined ? {} : { operator }),
    ...(row.restoredFrom === undefined ? {} : { restoredFrom: row.restoredFrom }),
    frontiers: bytesToBase64Url(row.frontiers),
  }
}

/**
 * Reads the planes the record only points at — each trash entry's bytes and
 * the saved versions — through the same scan that finds the images, so what
 * is carried is exactly what was judged. Fails closed: a version or a trash
 * entry the scan could not read is left behind and named, never sent.
 */
export async function readCarriedPlanes(
  record: LoroDoc,
  sourceWorkspaceId: string,
): Promise<CarriedPlanes> {
  const blobStore = new IdbBlobStore()
  const trashBytes = new Map<string, Uint8Array>()
  const rows = await savedVersionRows(sourceWorkspaceId)
  const scan = await scanFileReferences(record, {
    trashBytes: async (entry) => {
      const bytes = (await blobStore.get({ ref: entry.blob }))?.bytes ?? null
      if (bytes !== null) trashBytes.set(entry.documentId, bytes)
      return bytes
    },
    versions: savedVersionReads(record, rows),
  })
  const leftBehind: string[] = []
  const unjudgedTrash = new Set(
    scan.unjudged.flatMap((held) => (held.kind === 'trash' ? [held.documentId] : [])),
  )
  const trash: PromotedTrashBytes[] = []
  const trashPaths = new Map<string, string>()
  for (const entry of readTrashEntries(record)) {
    const bytes = trashBytes.get(entry.documentId)
    if (bytes === undefined || unjudgedTrash.has(entry.documentId)) {
      leftBehind.push(`the trashed document "${entry.path}" cannot be read in this browser`)
    } else {
      trash.push({ documentId: entry.documentId, bytes: bytesToBase64Url(bytes) })
      trashPaths.set(entry.documentId, entry.path)
    }
  }
  const unjudgedVersions = new Set(
    scan.unjudged.flatMap((held) => (held.kind === 'version' ? [held.versionId] : [])),
  )
  if (unjudgedVersions.size > 0) {
    leftBehind.push(
      `${countOf(unjudgedVersions.size, 'saved version', 'saved versions')} could not be read`,
    )
  }
  if (scan.unjudged.some((held) => held.kind === 'unreadable-node')) {
    leftBehind.push('part of the workspace could not be read by this version of the app')
  }
  const holders = new Set([
    ...readWorkspaceDocuments(record).map((entry) => entry.documentId),
    ...trash.map((carried) => carried.documentId),
  ])
  const versions = rows
    .filter((row) => holders.has(row.documentId) && !unjudgedVersions.has(row.id))
    .map(promotedVersion)
  return { trash, versions, trashPaths, leftBehind, scan }
}

/** The planes fitted into one promote body: what is sent, and what did not fit. */
export interface FittedPlanes {
  readonly trash: PromotedTrashBytes[]
  readonly versions: PromotedVersion[]
  readonly leftBehind: string[]
}

/**
 * The versions one move carries when there are more than the keeper takes:
 * the newest, manual saves before automatic checkpoints — an automatic one is
 * what the keeper's own retention would let go first. Kept in the order they
 * were read.
 */
function versionsWithinCap(
  versions: readonly PromotedVersion[],
  cap: number,
): { readonly kept: PromotedVersion[]; readonly dropped: number } {
  if (versions.length <= cap) return { kept: [...versions], dropped: 0 }
  const keep = new Set(
    [...versions]
      .sort((a, b) => Number(a.auto) - Number(b.auto) || b.createdAt - a.createdAt)
      .slice(0, cap),
  )
  return { kept: versions.filter((version) => keep.has(version)), dropped: versions.length - cap }
}

interface CarriedPlaneCaps {
  readonly trash: number
  readonly versions: number
}

/** The most trash entries and versions the keeper accepts in one move. */
const PROMOTE_CAPS: CarriedPlaneCaps = {
  trash: PROMOTE_MAX_TRASH,
  versions: PROMOTE_MAX_VERSIONS,
}

/**
 * The planes that fit beside `snapshot` inside the ceiling the keeper refuses
 * past, and inside the most trash entries and versions one move carries. The
 * record and the version rows are small beside a document's evacuated bytes,
 * so trash entries are what gives way to the byte ceiling: each that does not
 * fit is left behind and named, and the move goes ahead with the rest.
 */
export function fitCarriedPlanes(
  snapshot: string,
  planes: Pick<CarriedPlanes, 'trash' | 'versions' | 'trashPaths'>,
  limitBytes: number = PROMOTE_REQUEST_LIMIT_BYTES,
  caps: CarriedPlaneCaps = PROMOTE_CAPS,
): FittedPlanes {
  const encoder = new TextEncoder()
  const { kept: versions, dropped } = versionsWithinCap(planes.versions, caps.versions)
  const base: PromoteWorkspaceRequest = { snapshot, trash: [], versions }
  let size = encoder.encode(JSON.stringify(base)).byteLength
  const trash: PromotedTrashBytes[] = []
  const leftBehind: string[] =
    dropped === 0
      ? []
      : [
          `${countOf(dropped, 'older saved version', 'older saved versions')}: one move carries at most ${caps.versions}`,
        ]
  for (const carried of planes.trash) {
    if (trash.length >= caps.trash) {
      const path = planes.trashPaths.get(carried.documentId) ?? carried.documentId
      leftBehind.push(
        `the trashed document "${path}": one move carries at most ${caps.trash} trashed documents`,
      )
      continue
    }
    // The item plus the comma that joins it to the one before.
    const itemSize = encoder.encode(JSON.stringify(carried)).byteLength + 1
    if (size + itemSize > limitBytes) {
      const path = planes.trashPaths.get(carried.documentId) ?? carried.documentId
      leftBehind.push(`the trashed document "${path}" is too large to move with the rest`)
    } else {
      trash.push(carried)
      size += itemSize
    }
  }
  return { trash, versions, leftBehind }
}

/**
 * What the keeper's own read-back says it did not take of what was sent —
 * `keeper` is how the sentence names it ("the daemon", "the keeper").
 */
export function unconfirmedPlanes(
  sent: Pick<PromoteWorkspaceRequest, 'trash' | 'versions'>,
  answer: { trashStored: readonly string[]; versionsKept: readonly string[] },
  keeper: string,
): string[] {
  const stored = new Set(answer.trashStored)
  const kept = new Set(answer.versionsKept)
  const trash = (sent.trash ?? []).filter((carried) => !stored.has(carried.documentId)).length
  const versions = (sent.versions ?? []).filter((version) => !kept.has(version.id)).length
  return planeCounts({ trash, versions }).map((phrase) => `${phrase} did not reach ${keeper}`)
}
