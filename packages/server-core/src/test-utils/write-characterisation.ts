// What a write tool leaves in the stored document, as the Loro readers answer
// it, and what each save hands the store and the document-written observer.
// Shared by the characterisation tests, whose golden files are recorded from a
// tool's behaviour before a change of how it writes, so that change stays a
// change of how it writes and never of what it stores.
import {
  readAnnotations,
  readCoreFacets,
  readDocumentKind,
  readEdgeLocks,
  readFacets,
  readMarkdownBody,
  readNodeLocks,
  readProposals,
  readSpatialCanvasWithSkipped,
  readTrustFacets,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  reassembleSnapshot,
  type SaveSnapshotInput,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc, VersionVector } from 'loro-crdt'
import { expect } from 'vitest'
import type { DocumentWritten, ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, registerDocumentInWorkspace } from './fake-document-store.js'
import { makeTestDeps } from './make-test-deps.js'

export const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
export const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
export const SECOND_DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
export const NOW = new Date('2026-01-02T03:04:05.000Z')

const docRefOf = (documentId: string) => ({
  kind: 'document' as const,
  workspaceId: WORKSPACE_ID,
  documentId,
})

class RecordingStore extends FakeDocumentStore {
  readonly saved: SaveSnapshotInput[] = []
  override async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    this.saved.push(input)
    await super.saveSnapshot(input)
  }
}

export interface Rig {
  readonly store: RecordingStore
  readonly deps: ServerDeps
  readonly written: Parameters<DocumentWritten>[0][]
}

export function rig(overrides: Partial<ServerDeps> = {}): Rig {
  const store = new RecordingStore()
  const written: Parameters<DocumentWritten>[0][] = []
  const deps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    documentWritten: async (event) => {
      written.push(event)
    },
    ...overrides,
  })
  return { store, deps, written }
}

/** Stores a document built by `configure`, places it as a board, and forgets the seeding save. */
export async function seed(
  rigged: Rig,
  configure: (doc: LoroDoc) => void,
  documentId: string = DOCUMENT_ID,
  path = 'doc',
): Promise<void> {
  const doc = new LoroDoc()
  configure(doc)
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await rigged.store.saveSnapshot({
    docRef: docRefOf(documentId),
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
  rigged.store.saved.length = 0
  await registerDocumentInWorkspace(rigged.store, WORKSPACE_ID, documentId, path)
}

/** Every plane the tools write, as the Loro readers answer it. */
export function contentOf(doc: LoroDoc) {
  const { canvas, skipped } = readSpatialCanvasWithSkipped(doc)
  return {
    kind: readDocumentKind(doc) ?? null,
    canvas,
    skipped,
    body: readMarkdownBody(doc),
    threads: readAnnotations(doc),
    proposals: readProposals(doc),
    nodeLocks: [...readNodeLocks(doc)].sort(),
    edgeLocks: [...readEdgeLocks(doc)].sort(),
    facets: readFacets(doc),
    coreFacets: readCoreFacets(doc) ?? null,
    trustFacets: readTrustFacets(doc) ?? null,
  }
}

export async function stored(store: FakeDocumentStore, documentId: string = DOCUMENT_ID) {
  const saved = await store.loadSnapshot({ docRef: docRefOf(documentId) })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return doc
}

/**
 * The record of one call: the stored content of each document, how many saves
 * it made, and what each save claimed against the bytes it carried and what the
 * observer was told.
 */
export async function record(rigged: Rig, documentIds: readonly string[] = [DOCUMENT_ID]) {
  // Named by position, so a document whose id was minted still has a stable golden.
  const aliasOf = (documentId: string) => `doc${documentIds.indexOf(documentId) + 1}`
  const content: Record<string, ReturnType<typeof contentOf>> = {}
  const decoded: Record<string, ReturnType<typeof contentOf>> = {}
  for (const documentId of documentIds) {
    const present = await rigged.store.loadSnapshot({ docRef: docRefOf(documentId) })
    if (present === null) continue
    const read = contentOf(await stored(rigged.store, documentId))
    decoded[documentId] = read
    content[aliasOf(documentId)] = read
  }
  const saves = rigged.store.saved.map((save) => {
    if (save.docRef.kind !== 'document') throw new Error('a tool saved something but a document')
    const carried = new LoroDoc()
    carried.import(reassembleSnapshot(save.manifest, save.chunks))
    return {
      documentId: aliasOf(save.docRef.documentId),
      chunks: save.chunks.length,
      // Compared as versions: the vector's byte order is a hash map's, so two
      // encodings of one version differ from run to run.
      frontierIsTheOplogVersion:
        VersionVector.decode(save.frontier).compare(carried.oplogVersion()) === 0,
      docRef: { ...save.docRef, documentId: aliasOf(save.docRef.documentId) },
    }
  })
  const events = rigged.written.map((event) => ({
    workspaceId: event.workspaceId,
    documentId: aliasOf(event.documentId),
    path: event.path ?? null,
    keys: Object.keys(event).sort(),
  }))
  for (const documentId of documentIds) {
    const last = rigged.written.filter((event) => event.documentId === documentId).at(-1)
    if (last !== undefined) expect(contentOf(last.doc)).toEqual(decoded[documentId])
  }
  return { content, saves, events }
}

export async function golden(directory: string, name: string, value: unknown) {
  await expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(
    `../tools/__snapshots__/${directory}/${name}.golden`,
  )
}
