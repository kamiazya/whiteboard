/**
 * The two record kinds the index runs over, behind the edits a test makes to a
 * record directly — content a document holds, filler nodes, a replica that
 * merges back — so a suite written once runs over both.
 *
 * Content and filler have no index op (the index never writes them), so each
 * subject carries them: through the document's containers on a `LoroDoc`, and
 * through the engine's writers on a lease. Edits are unjudged on the lease, as
 * a `LoroDoc` edit is.
 */
import {
  documentContainers,
  type LegacyRecord,
  lease as leases,
  loadCrdtEngine,
  type RecordLease,
  readCommentThreads,
  readMarkdownBody,
  readSpatialCanvas,
  readWorkspaceDocuments,
  readWorkspaceNodes,
  WORKSPACE_TREE_KEY,
  writeCommentThread,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type BlobStore, blobRefKey } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { type IndexRecordKind, leaseIndexKind, loroIndexKind } from '../index-record-kind.js'
import {
  LoroWorkspaceDocumentIndex,
  type TrashBlobNamedElsewhere,
  type WorkspaceRegistry,
} from '../loro-workspace-document-index.js'
import type { WorkspaceDocs } from '../workspace-docs.js'

export interface IndexSubject {
  readonly name: string
  readonly kind: IndexRecordKind<unknown>
  /** The record as an index may open it without owning it: releasing it gives nothing back. */
  borrow(record: unknown): unknown
  /** Adds raw document nodes until the record holds `total`. */
  fillDocuments(record: unknown, total: number): Promise<void>
  /** Adds empty folders at the root until the record holds `total`. */
  fillFolders(record: unknown, total: number): Promise<void>
  /** A folder named `segment` directly under the node at `parentPath`. */
  addFolderUnder(record: unknown, parentPath: string, segment: string): Promise<void>
  writeCanvas(record: unknown, documentId: string, canvas: SpatialCanvas): void
  readCanvas(record: unknown, documentId: string): SpatialCanvas
  writeBody(record: unknown, documentId: string, body: string): void
  readBody(record: unknown, documentId: string): string
  writeThread(record: unknown, documentId: string, thread: CommentThread): void
  threadIds(record: unknown, documentId: string): string[]
  /** A copy of the record that writes as another peer. */
  replica(record: unknown, peer: number): unknown
  /** Merges everything `from` holds into `into`. */
  merge(into: unknown, from: unknown): void
}

/** `n` in the ULID alphabet, so a seeded id is canonical. */
function crockford(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  let rest = n
  do {
    out = alphabet[rest % 32] + out
    rest = Math.floor(rest / 32)
  } while (rest > 0)
  return out
}

const fillerId = (i: number) => `01BRWC${crockford(i).padStart(20, '0')}`

const foldersHeld = (doc: LegacyRecord) =>
  readWorkspaceNodes(doc).filter((node) => node.type === 'folder').length

function rawDocuments(doc: LegacyRecord, from: number, total: number): void {
  const tree = doc.getTree(WORKSPACE_TREE_KEY)
  for (let i = from; i < total; i++) {
    const node = tree.createNode()
    node.data.set('documentId', fillerId(i))
    node.data.set('segment', `filler-${i}`)
    node.data.set('kind', 'markdown')
    node.data.set('createdAt', 1_000)
    node.data.set('updatedAt', 1_000)
  }
  doc.commit()
}

function rawFolders(doc: LegacyRecord, from: number, total: number): void {
  const tree = doc.getTree(WORKSPACE_TREE_KEY)
  for (let i = from; i < total; i++) tree.createNode().data.set('segment', `f${i}`)
  doc.commit()
}

/**
 * Filler is built on a scratch `LoroDoc` and merged in: a writer per node walks
 * the whole tree each time, which makes thousands of them quadratic.
 */
function mergedFiller(record: unknown, fill: (scratch: LegacyRecord) => void): void {
  const scratch = new LoroDoc()
  fill(scratch)
  leaseSubject.kind.importInto(record, new Uint8Array(scratch.export({ mode: 'update' })))
}

const loroSubject: IndexSubject = {
  name: 'loroDocKind',
  kind: loroIndexKind as IndexRecordKind<unknown>,
  borrow: (record) => record,
  async fillDocuments(record, total) {
    const doc = record as LegacyRecord
    rawDocuments(doc, readWorkspaceDocuments(doc).length, total)
  },
  async fillFolders(record, total) {
    const doc = record as LegacyRecord
    rawFolders(doc, foldersHeld(doc), total)
  },
  async addFolderUnder(record, parentPath, segment) {
    const doc = record as LegacyRecord
    const parent = (await loroSubject.kind.nodes(doc)).find((node) => node.path === parentPath)
    if (parent === undefined) throw new Error(`no node at ${parentPath}`)
    const top = doc.getTree(WORKSPACE_TREE_KEY).roots()[0]
    top?.createNode().data.set('segment', segment)
    doc.commit()
  },
  writeCanvas: (record, id, canvas) =>
    writeSpatialCanvas(documentContainers(record as LegacyRecord, id), canvas),
  readCanvas: (record, id) => readSpatialCanvas(documentContainers(record as LegacyRecord, id)),
  writeBody(record, id, body) {
    writeMarkdownBody(documentContainers(record as LegacyRecord, id), body)
    ;(record as LegacyRecord).commit()
  },
  readBody: (record, id) => readMarkdownBody(documentContainers(record as LegacyRecord, id)),
  writeThread(record, id, thread) {
    writeCommentThread(documentContainers(record as LegacyRecord, id), thread)
  },
  threadIds: (record, id) =>
    readCommentThreads(documentContainers(record as LegacyRecord, id))
      .map((thread) => thread.id)
      .sort(),
  replica(record, peer) {
    const copy = LoroDoc.fromSnapshot((record as LegacyRecord).export({ mode: 'snapshot' }))
    copy.setPeerId(BigInt(peer))
    return copy
  },
  merge(into, from) {
    ;(into as LegacyRecord).import((from as LegacyRecord).export({ mode: 'update' }))
  },
}

const asValue = <T>() => ({ parse: (value: unknown) => value as T })

function contentWrite(record: unknown, op: string, args: Record<string, unknown>): void {
  leases.write(record as RecordLease, [{ op: op as 'writeMarkdownBody', args }], {
    judge: 'none',
  })
}

const leaseSubject: IndexSubject = {
  name: 'leaseKind',
  kind: leaseIndexKind(loadCrdtEngine) as IndexRecordKind<unknown>,
  borrow: (record) => ({ ...(record as RecordLease), release() {} }),
  async fillDocuments(record, total) {
    const held = (await leaseSubject.kind.documents(record)).length
    mergedFiller(record, (scratch) => rawDocuments(scratch, held, total))
  },
  async fillFolders(record, total) {
    const held = (await leaseSubject.kind.nodes(record)).filter(
      (node) => node.type === 'folder',
    ).length
    mergedFiller(record, (scratch) => rawFolders(scratch, held, total))
  },
  async addFolderUnder(record, parentPath, segment) {
    contentWrite(record, 'ensureFolderPath', { segments: [...parentPath.split('/'), segment] })
  },
  writeCanvas: (record, documentId, canvas) =>
    contentWrite(record, 'writeSpatialCanvas', { documentId, canvas }),
  readCanvas: (record, documentId) =>
    leases.readNow(
      record as RecordLease,
      { query: 'spatialCanvas', args: { documentId } },
      asValue<{ canvas: SpatialCanvas }>(),
    ).canvas,
  writeBody: (record, documentId, body) =>
    contentWrite(record, 'writeMarkdownBody', { documentId, body }),
  readBody: (record, documentId) =>
    leases.readNow(
      record as RecordLease,
      { query: 'markdownBody', args: { documentId } },
      asValue<string>(),
    ),
  writeThread: (record, documentId, thread) =>
    contentWrite(record, 'writeCommentThread', { documentId, thread }),
  threadIds: (record, documentId) =>
    leases
      .readNow(
        record as RecordLease,
        { query: 'commentThreads', args: { documentId } },
        asValue<CommentThread[]>(),
      )
      .map((thread) => thread.id)
      .sort(),
  replica(record, peer) {
    const held = record as RecordLease
    return leases.ownedLease(
      held.engine,
      held.engine.fork({ handle: held.handle, peer: String(peer) }).handle,
    )
  },
  merge(into, from) {
    leaseSubject.kind.importInto(into, leaseSubject.kind.exportUpdateSince(from, null))
  },
}

export const INDEX_SUBJECTS: readonly IndexSubject[] = [loroSubject, leaseSubject]

/** A record per workspace that stays live: what a test edits through `peek` is what the index reads. */
export function liveWorkspaceDocs(
  subject: IndexSubject,
): WorkspaceDocs<unknown> & { peek: (id: string) => unknown } {
  const held = new Map<string, unknown>()
  const notTailing = (): Promise<never> => Promise.reject(new Error('not implemented'))
  return {
    async open(workspaceId) {
      const record = held.get(workspaceId)
      return record === undefined ? null : subject.borrow(record)
    },
    async create(workspaceId) {
      if (!held.has(workspaceId)) held.set(workspaceId, await subject.kind.empty())
      return subject.borrow(held.get(workspaceId))
    },
    async save() {
      return null
    },
    // These doubles serve INDEX tests, which never tail. Rejecting rather than
    // answering an empty cursor: a silent no-op would let a tailing test pass
    // against a double that cannot tail.
    readCursor: notTailing,
    catchUp: notTailing,
    storedVersion: notTailing,
    peek: (id) => held.get(id),
  }
}

/** Records kept the way a real store keeps them: only what `save` exported survives. */
export function storedWorkspaceDocs(subject: IndexSubject): WorkspaceDocs<unknown> & {
  stored: Map<string, Uint8Array>
} {
  const stored = new Map<string, Uint8Array>()
  const notTailing = (): Promise<never> => Promise.reject(new Error('not implemented'))
  const docs: WorkspaceDocs<unknown> & { stored: Map<string, Uint8Array> } = {
    stored,
    async open(workspaceId) {
      const bytes = stored.get(workspaceId)
      return bytes === undefined ? null : subject.kind.load(bytes, [])
    },
    async create(workspaceId) {
      return (await docs.open(workspaceId)) ?? subject.kind.empty()
    },
    async save(workspaceId, record) {
      stored.set(workspaceId, subject.kind.exportSnapshot(record))
      return null
    },
    readCursor: notTailing,
    catchUp: notTailing,
    storedVersion: notTailing,
  }
  return docs
}

/** Enough of a `BlobStore` for the evacuation a delete performs. */
export function inMemoryBlobStore(): BlobStore & { size: () => number } {
  const blobs = new Map<string, Uint8Array>()
  let next = 0
  return {
    async put({ bytes }) {
      // A counter, not a real digest: nothing here reads the ref back for its
      // content-addressing, and hashing would pull DOM types into a package
      // that has none.
      next += 1
      const ref = { algorithm: 'sha-256', digestHex: String(next).padStart(64, '0') } as const
      blobs.set(blobRefKey(ref), new Uint8Array(bytes))
      return { ref }
    },
    async get({ ref }) {
      const bytes = blobs.get(blobRefKey(ref))
      return bytes === undefined ? null : { bytes: new Uint8Array(bytes) }
    },
    async has({ ref }) {
      return { exists: blobs.has(blobRefKey(ref)) }
    },
    async delete({ ref }) {
      blobs.delete(blobRefKey(ref))
    },
    size: () => blobs.size,
  }
}

/** A registry for a test that never renames: rejects rather than answering. */
export const notRenamingRegistry = {
  listWorkspaces: async () => [],
  findWorkspace: async () => null,
  renameWorkspace: (): Promise<never> => Promise.reject(new Error('not implemented')),
}

/** The index over `docs`, holding records as the subject's kind does. */
export function indexOver(
  subject: IndexSubject,
  docs: WorkspaceDocs<unknown>,
  blobs: BlobStore,
  registry: WorkspaceRegistry = notRenamingRegistry,
  options: { readonly trashBlobNamedElsewhere?: TrashBlobNamedElsewhere } = {},
): LoroWorkspaceDocumentIndex<unknown> {
  return new LoroWorkspaceDocumentIndex(docs, blobs, registry, { ...options, kind: subject.kind })
}
