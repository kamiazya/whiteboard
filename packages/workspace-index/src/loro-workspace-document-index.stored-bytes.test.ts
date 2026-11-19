/**
 * What the index leaves in a record's store does not depend on how the record
 * is held. The same scripted index operations, as the same peer at the same
 * instants, through a `LoroDoc` and through an engine lease leave the same
 * snapshot, deltas and frontier — so a workspace written by one is read back
 * by the other and by every older release.
 */
import {
  type LegacyRecord,
  loadCrdtEngine,
  loroDocKind,
  type RecordKind,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordStoreWorkspaceDocs } from './document-store-workspace-docs.js'
import { type IndexRecordKind, leaseIndexKind, loroIndexKind } from './index-record-kind.js'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import { inMemoryBlobStore } from './test-utils/index-subjects.js'

// Document ids are minted by the index, so a run's bytes can only be compared
// when each run mints the same sequence.
const minted = vi.hoisted(() => ({ next: 0 }))
vi.mock('@kamiazya/whiteboard-model', async (original) => ({
  ...(await original<typeof import('@kamiazya/whiteboard-model')>()),
  generateDocumentId: () => {
    minted.next += 1
    return `01BRWD${String(minted.next).padStart(20, '0')}`
  },
}))

const PEER = '4242'
const WS = '01BSXMXYEPZGZYHNN3KTQZ33EE'
const REF: DocRef = { kind: 'workspace-tree', workspaceId: WS }

/** A `LoroDoc` kind whose every record writes as `PEER`, as the lease kind's does. */
const docOfPeer: RecordKind<LegacyRecord> = {
  ...loroDocKind,
  async load(snapshot, updates) {
    const doc = await loroDocKind.load(snapshot, updates)
    doc.setPeerId(BigInt(PEER))
    return doc
  },
  async empty() {
    const doc = new LoroDoc()
    doc.setPeerId(BigInt(PEER))
    return doc
  },
}

const subjects: ReadonlyArray<{ name: string; kind: IndexRecordKind<unknown> }> = [
  { name: 'loroDocKind', kind: { ...loroIndexKind, ...docOfPeer } as IndexRecordKind<unknown> },
  {
    name: 'leaseKind',
    kind: leaseIndexKind(loadCrdtEngine, { peer: () => PEER }) as IndexRecordKind<unknown>,
  },
]

async function stored(store: InMemoryDocumentStore) {
  const snapshot = await store.loadSnapshot({ docRef: REF })
  const tail = await store.loadDeltas({ docRef: REF, afterSeq: null })
  return {
    snapshot: snapshot === null ? null : reassembleSnapshot(snapshot.manifest, snapshot.chunks),
    snapshotFrontier: snapshot?.frontier ?? null,
    deltas: tail.updates,
    frontier: (await store.readFrontier({ docRef: REF }))?.frontier ?? null,
  }
}

const registry = {
  listWorkspaces: async () => [],
  findWorkspace: async () => null,
  renameWorkspace: (): Promise<never> => Promise.reject(new Error('not implemented')),
}

/** Every kind of write the index makes, once or twice, in an order that makes each depend on the last. */
async function run(kind: IndexRecordKind<unknown>) {
  minted.next = 0
  const store = new InMemoryDocumentStore()
  const docs = new RecordStoreWorkspaceDocs(store, kind)
  const index = new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), registry, { kind })
  await index.createWorkspace({ workspaceId: WS })
  const at = (path: string) => ({ workspaceId: WS, path })
  await index.createDocument({ ...at('plans/q1/roadmap'), kind: 'markdown', name: 'Roadmap' })
  await index.createDocument({ ...at('plans/q1/board'), kind: 'spatial' })
  await index.createDocument({ ...at('notes'), kind: 'markdown' })
  await index.setFolderName({ workspaceId: WS, path: 'plans/q1', name: 'Quarter one' })
  await index.moveDocument({ workspaceId: WS, from: 'plans/q1/board', to: 'board' })
  await index.createDocument({ ...at('plans/q2/plan'), kind: 'markdown' })
  await index.setFolderName({ workspaceId: WS, path: 'plans/q2', name: 'Quarter two' })
  await index.setFolderName({ workspaceId: WS, path: 'plans/q2', name: undefined })
  const notes = await index.resolveDocument(at('notes'))
  await index.setDocumentName({
    workspaceId: WS,
    documentId: notes?.documentId ?? '',
    name: 'Notes',
  })
  await index.setDocumentPinned({
    workspaceId: WS,
    documentId: notes?.documentId ?? '',
    pinned: true,
  })
  await index.duplicateDocument(at('notes'))
  // The trash row records the folder name above the document, and a restore gives it back.
  const roadmap = await index.resolveDocument(at('plans/q1/roadmap'))
  await index.deleteDocument(at('plans/q1/roadmap'))
  const restored = await index.restoreDocument({
    workspaceId: WS,
    documentId: roadmap?.documentId ?? '',
  })
  const folderNames = await index.listFolderNames({ workspaceId: WS })
  await index.deleteDocument(at('plans/q1/roadmap'))
  await index.purgeTrashEntry({ workspaceId: WS, documentId: roadmap?.documentId ?? '' })
  await index.deleteDocument(at('board'))
  return {
    restored,
    folderNames,
    held: await stored(store),
    listed: await index.listDocuments({ workspaceId: WS }),
  }
}

describe('the bytes the index leaves in a keeper', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('are identical whether the record is a LoroDoc or an engine lease', async () => {
    const [viaDoc, viaLease] = [await run(subjects[0]!.kind), await run(subjects[1]!.kind)]

    // The run did something: documents stand, and the log holds the writes.
    expect(viaDoc.listed.map((entry) => entry.path).sort()).toEqual(
      ['notes-copy', 'notes', 'plans/q2/plan'].sort(),
    )
    expect(viaDoc.held.snapshot?.byteLength).toBeGreaterThan(0)
    expect(viaDoc.held.deltas.length).toBeGreaterThan(5)
    // The restore placed the document and gave its folder its name back.
    expect(viaDoc.restored?.path).toBe('plans/q1/roadmap')
    expect(viaDoc.folderNames).toEqual([{ path: 'plans/q1', name: 'Quarter one' }])
    expect(viaLease.listed).toEqual(viaDoc.listed)
    expect(viaLease.held.frontier).toEqual(viaDoc.held.frontier)
    expect(viaLease.held.snapshotFrontier).toEqual(viaDoc.held.snapshotFrontier)
    expect(viaLease.held.snapshot).toEqual(viaDoc.held.snapshot)
    expect(viaLease.held.deltas).toEqual(viaDoc.held.deltas)
  })
})
