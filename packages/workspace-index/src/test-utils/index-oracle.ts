/**
 * What the recorder (`scripts/record-index-oracle.ts`) and the replay
 * (`oracle/index-rules-recorded-oracle.test.ts`) both use to run one recorded
 * row: the pure index rules over plain values, and the index's operations over
 * a workspace record held as an engine lease. A refusal is recorded as its
 * class and the plain fields it carries, because the Rust replay has to refuse
 * the same inputs and a message is the one thing a port words differently.
 *
 * Everything a row depends on that is not in the row is pinned here: the clock,
 * the peer the record writes as, and the entropy `generateDocumentId` draws
 * (the ids a call mints are recorded as `mint`, so a port injects them).
 */
import {
  type CrdtEngine,
  loadCrdtEngine,
  type RecordLease,
  type TrashEntry,
  type WorkspaceNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  bytesToBase64,
  base64ToBytes as decodeBase64,
  isSelfOrDescendant,
} from '@kamiazya/whiteboard-model'
import type { BlobStore } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { firstFreeSegment } from '../first-free-segment.js'
import { leaseIndexKind } from '../index-record-kind.js'
import {
  distinctUnnamedPath,
  entryOf,
  isNamedByAnotherRow,
  refuseMovedName,
  refuseSiblingDocumentName,
  sameDisplayName,
} from '../index-rules.js'
import { LoroWorkspaceDocumentIndex } from '../loro-workspace-document-index.js'
import { moveCollision } from '../move-collision.js'
import { restorableTrashDocuments } from '../restore-judgement.js'
import type { WorkspaceDocs } from '../workspace-docs.js'
import { notRenamingRegistry } from './index-subjects.js'

/** A recorded row holds valid base64; one that does not is a corrupt recording. */
function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(text)
  if (bytes === null) throw new Error('a recorded row holds bytes that are not base64')
  return bytes
}

const RECORDED_NOW = 1_700_000_000_000
export const WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

export type Answer = { ok: unknown } | { err: string; fields?: Record<string, unknown> }

const plain = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value))

/** The plain-valued own fields of a refusal: the path, the name, the kind a port builds its message from. */
function fieldsOf(error: Error): Record<string, unknown> | undefined {
  const found: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(error)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      found[key] = value
    }
  }
  return Object.keys(found).length === 0 ? undefined : found
}

function refusal(error: unknown): Answer {
  if (!(error instanceof Error)) return { err: typeof error }
  const fields = error.constructor.name === 'ZodError' ? undefined : fieldsOf(error)
  return { err: error.constructor.name, ...(fields === undefined ? {} : { fields }) }
}

function answer(read: () => unknown): Answer {
  try {
    return { ok: plain(read()) }
  } catch (error) {
    return refusal(error)
  }
}

async function answerAsync(read: () => Promise<unknown>): Promise<Answer> {
  try {
    return { ok: plain(await read()) }
  } catch (error) {
    return refusal(error)
  }
}

// ---- the pure rules ----

export interface PureRow {
  op: string
  // Each op reads the fields it names; a row carries only those.
  base?: string
  taken?: string[]
  takenThrough?: number
  nodes?: WorkspaceNode[]
  from?: string
  to?: string
  current?: string
  next?: string
  path?: string
  name?: string
  documentId?: string
  rows?: TrashEntry[]
  entry?: TrashEntry
  found?: Parameters<typeof entryOf>[0]
  bytes?: string
  parentPath?: string | null
}

/**
 * The segments a `firstFreeSegment` row holds: the ones listed, and the whole
 * series `base-2` to `base-<takenThrough>` when a row says so, since a row
 * that names a thousand of them would be most of the file.
 */
function takenSet(row: PureRow): Set<string> {
  const held = new Set(row.taken ?? [])
  for (let n = 2; n <= (row.takenThrough ?? 1); n++) held.add(`${row.base}-${n}`)
  return held
}

export async function replayPure(row: PureRow): Promise<Answer> {
  const nodes = row.nodes ?? []
  switch (row.op) {
    case 'firstFreeSegment': {
      const held = takenSet(row)
      return answerAsync(() => firstFreeSegment(row.base as string, (s) => held.has(s)))
    }
    case 'moveCollision': {
      const moving = nodes.filter((node) => isSelfOrDescendant(node.path, row.from as string))
      return answer(() => moveCollision(nodes, moving, row.from as string, row.to as string))
    }
    case 'sameDisplayName':
      return answer(() => sameDisplayName(row.current, row.next as string))
    case 'refuseSiblingDocumentName':
      return answer(() =>
        refuseSiblingDocumentName(nodes, row.path as string, row.name as string, row.documentId),
      )
    case 'refuseMovedName': {
      const moving = nodes.filter((node) => isSelfOrDescendant(node.path, row.from as string))
      return answer(() => refuseMovedName(nodes, moving, row.from as string, row.to as string))
    }
    case 'distinctUnnamedPath':
      return answer(() => distinctUnnamedPath(nodes, row.path as string))
    case 'isNamedByAnotherRow':
      return answer(() => isNamedByAnotherRow(row.rows ?? [], row.entry as TrashEntry))
    case 'entryOf':
      return answer(() => entryOf(row.found as Parameters<typeof entryOf>[0]))
    case 'restorableTrashDocuments':
      return answerAsync(() =>
        restorableTrashDocuments(base64ToBytes(row.bytes as string), {
          documentId: row.documentId as string,
          parentPath: row.parentPath ?? undefined,
        }),
      )
    default:
      throw new Error(`no replay for ${row.op}`)
  }
}

// ---- the index over a record held as an engine lease ----

export interface BlobRow {
  digestHex: string
  bytes: string
}

export interface IndexRow {
  op: string
  /** The workspace record's snapshot, or `null` for a workspace nobody holds. */
  before: string | null
  blobs: BlobRow[]
  args: Record<string, unknown>
  /** The ids the call mints, in order. */
  mint: string[]
}

export interface IndexOutcome {
  result: Answer
  /** The record as the keeper stored it after the call: container ids included. */
  deep: unknown
  vv: Array<[string, number]>
  saves: number
  blobs: BlobRow[]
  /** The stored record's snapshot, for a scene that continues from this call. */
  stored: string | null
  /** How many of the row's `mint` the call drew. */
  minted: number
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Runs `body` with the clock at `RECORDED_NOW` and the 16 bytes
 * `generateDocumentId` asks for taken from `mint`, an id at a time. Any other
 * request for entropy passes through, so nothing else is made repeatable by
 * this; the record's peer is fixed by the lease kind instead.
 */
export async function pinned<T>(
  mint: readonly string[],
  body: (drawn: () => number) => Promise<T>,
): Promise<T> {
  const queue = mint.map((id) => [...id.slice(10)].map((char) => ALPHABET.indexOf(char)))
  let drawn = 0
  type FillRandom = <T extends ArrayBufferView>(array: T) => T
  const source = globalThis.crypto as unknown as { getRandomValues: FillRandom }
  const real = source.getRandomValues.bind(globalThis.crypto)
  const realNow = Date.now
  source.getRandomValues = (<T extends ArrayBufferView>(array: T): T => {
    const next = array instanceof Uint8Array && array.length === 16 ? queue.shift() : undefined
    if (next === undefined) return real(array)
    ;(array as unknown as Uint8Array).set(next)
    drawn += 1
    return array
  }) as FillRandom
  Date.now = () => RECORDED_NOW
  try {
    return await body(() => drawn)
  } finally {
    Reflect.deleteProperty(source, 'getRandomValues')
    Date.now = realNow
  }
}

/** A blob store whose digests are counters, so a recorded store replays with the same refs. */
function blobStoreOf(initial: readonly BlobRow[]): BlobStore & { rows: () => BlobRow[] } {
  const held = new Map<string, BlobRow>(initial.map((blob) => [blob.digestHex, blob]))
  let next = 0
  const keyOf = (ref: { digestHex: string }) => ref.digestHex
  return {
    async put({ bytes }) {
      let digestHex: string
      do {
        next += 1
        digestHex = String(next).padStart(64, '0')
      } while (held.has(digestHex))
      held.set(digestHex, { digestHex, bytes: bytesToBase64(bytes) })
      return { ref: { algorithm: 'sha-256', digestHex } }
    },
    async get({ ref }) {
      const blob = held.get(keyOf(ref))
      return blob === undefined ? null : { bytes: base64ToBytes(blob.bytes) }
    },
    async has({ ref }) {
      return { exists: held.has(keyOf(ref)) }
    },
    async delete({ ref }) {
      held.delete(keyOf(ref))
    },
    rows: () => [...held.values()].sort((a, b) => a.digestHex.localeCompare(b.digestHex)),
  }
}

/**
 * The addresses an operation left in the blob store. Not the bytes: an
 * evacuated subtree is exported through a document with a random peer, so its
 * length is not a function of the row.
 */
export const blobSummary = (rows: readonly BlobRow[]): string[] => rows.map((row) => row.digestHex)

const PEER = '1'

const pairsOf = (doc: LoroDoc): Array<[string, number]> =>
  [...doc.oplogVersion().toJSON().entries()]
    .map(([peer, counter]) => [String(peer), counter] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]))

const docOf = (b64: string): LoroDoc => {
  const doc = new LoroDoc()
  doc.import(base64ToBytes(b64))
  return doc
}

function callOf(
  index: LoroWorkspaceDocumentIndex<RecordLease>,
  op: string,
  call: never,
): Promise<unknown> {
  switch (op) {
    case 'createDocument':
      return index.createDocument(call)
    case 'duplicateDocument':
      return index.duplicateDocument(call)
    case 'resolveDocument':
      return index.resolveDocument(call)
    case 'resolveDocumentById':
      return index.resolveDocumentById(call)
    case 'listDocuments':
      return index.listDocuments(call)
    case 'moveDocument':
      return index.moveDocument(call)
    case 'setDocumentName':
      return index.setDocumentName(call)
    case 'listPinnedDocuments':
      return index.listPinnedDocuments(call)
    case 'setDocumentPinned':
      return index.setDocumentPinned(call)
    case 'listFolderNames':
      return index.listFolderNames(call)
    case 'setFolderName':
      return index.setFolderName(call)
    case 'deleteDocument':
      return index.deleteDocument(call)
    case 'listTrash':
      return index.listTrash(call)
    case 'restoreDocument':
      return index.restoreDocument(call)
    case 'purgeTrashEntry':
      return index.purgeTrashEntry(call)
    default:
      throw new Error(`no replay for ${op}`)
  }
}

export async function replayIndex(row: IndexRow, engine?: CrdtEngine): Promise<IndexOutcome> {
  const loaded = engine ?? (await loadCrdtEngine())
  const kind = leaseIndexKind(async () => loaded, { peer: () => PEER })
  let stored: Uint8Array | null = row.before === null ? null : base64ToBytes(row.before)
  let saves = 0
  const docs: WorkspaceDocs<RecordLease> = {
    async open() {
      return stored === null ? null : kind.load(stored, [])
    },
    async create() {
      return kind.empty()
    },
    async save(_workspaceId, record) {
      saves += 1
      stored = kind.exportSnapshot(record)
      return null
    },
    readCursor: () => Promise.reject(new Error('not implemented')),
    catchUp: () => Promise.reject(new Error('not implemented')),
    storedVersion: () => Promise.reject(new Error('not implemented')),
  }
  const blobs = blobStoreOf(row.blobs)
  const index = new LoroWorkspaceDocumentIndex(docs, blobs, notRenamingRegistry, { kind })
  const run = () => callOf(index, row.op, row.args as never)
  return pinned(row.mint, async (drawn) => {
    const result = await answerAsync(run)
    const after = stored === null ? null : docOf(bytesToBase64(stored))
    return {
      result,
      deep: after === null ? null : plain(after.getDeepValueWithID()),
      vv: after === null ? [] : pairsOf(after),
      saves,
      blobs: blobs.rows(),
      stored: stored === null ? null : bytesToBase64(stored),
      minted: drawn(),
    }
  })
}
