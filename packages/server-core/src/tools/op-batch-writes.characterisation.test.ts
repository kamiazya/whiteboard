// What a mixed batch through each op-batch write tool leaves in the stored
// document, as the Loro readers answer it, and what each save hands the store
// and the document-written observer. The golden files are recorded from the
// tools' behaviour before they wrote through the engine, so a change of how
// they write stays a change of how they write and never of what they store.
import {
  readAnnotations,
  readDocumentKind,
  readEdgeLocks,
  readFacets,
  readMarkdownBody,
  readNodeLocks,
  readProposals,
  readSpatialCanvasWithSkipped,
  writeCommentThread,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeProposal,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  reassembleSnapshot,
  type SaveSnapshotInput,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc, VersionVector } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DocumentWritten, ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { createThreadEditTool } from './thread-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const docRef = { kind: 'document' as const, workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }
const NOW = new Date('2026-01-02T03:04:05.000Z')

class RecordingStore extends FakeDocumentStore {
  readonly saved: SaveSnapshotInput[] = []
  override async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    this.saved.push(input)
    await super.saveSnapshot(input)
  }
}

interface Rig {
  readonly store: RecordingStore
  readonly deps: ServerDeps
  readonly written: DocumentWritten[]
}

function rig(): Rig {
  const store = new RecordingStore()
  const written: DocumentWritten[] = []
  const deps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    documentWritten: async (event) => {
      written.push(event)
    },
  })
  return { store, deps, written }
}

async function seed(rigged: Rig, configure: (doc: LoroDoc) => void): Promise<void> {
  const doc = new LoroDoc()
  configure(doc)
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await rigged.store.saveSnapshot({
    docRef,
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
  rigged.store.saved.length = 0
  await registerDocumentInWorkspace(rigged.store, WORKSPACE_ID, DOCUMENT_ID)
}

/** Every plane the tools write, as the Loro readers answer it. */
function contentOf(doc: LoroDoc) {
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
  }
}

async function stored(store: FakeDocumentStore) {
  const saved = await store.loadSnapshot({ docRef })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return doc
}

/**
 * The record of one call: the stored content, how many saves it made, and what
 * each save claimed against the bytes it carried and what the observer was told.
 */
async function record(rigged: Rig) {
  const doc = await stored(rigged.store)
  const content = contentOf(doc)
  const saves = rigged.store.saved.map((save) => {
    const carried = new LoroDoc()
    carried.import(reassembleSnapshot(save.manifest, save.chunks))
    return {
      chunks: save.chunks.length,
      // Compared as versions: the vector's byte order is a hash map's, so two
      // encodings of one version differ from run to run.
      frontierIsTheOplogVersion:
        VersionVector.decode(save.frontier).compare(carried.oplogVersion()) === 0,
      docRef: save.docRef,
    }
  })
  const events = rigged.written.map((event) => ({
    workspaceId: event.workspaceId,
    documentId: event.documentId,
    path: event.path ?? null,
    keys: Object.keys(event).sort(),
    contentOfDoc: contentOf(event.doc),
  }))
  expect(events.at(-1)?.contentOfDoc).toEqual(content)
  return { content, saves, events }
}

async function golden(name: string, value: unknown) {
  await expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(
    `./__snapshots__/op-batch-writes/${name}.json`,
  )
}

const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 200, height: 60, text: 'Alpha beta' }),
    textNode({ id: 'b', x: 300, y: 0, width: 200, height: 60, text: 'Gamma' }),
    textNode({ id: 'c', x: 600, y: 0, width: 200, height: 60, text: 'Delta' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
  tags: ['kept'],
}

const NOTE = 'one two three four five six'

function span(text: string, exact: string) {
  const start = text.indexOf(exact)
  return { quote: { exact }, start, end: start + exact.length }
}
const at = (text: string, exact: string) => ({ kind: 'text' as const, ...span(text, exact) })

const seedBoard = (rigged: Rig, kinded = true) =>
  seed(rigged, (doc) => {
    if (kinded) writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, BOARD)
    writeFacets(doc, { 'example.sample/v1': { status: 'open' } })
  })

const indexAsMarkdown = (rigged: Rig) =>
  rigged.store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'markdown',
  })

const seedNote = (rigged: Rig) =>
  seed(rigged, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, NOTE)
    writeFacets(doc, { 'example.sample/v1': { status: 'open' } })
  }).then(() => indexAsMarkdown(rigged))

describe('what the op-batch write tools store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('wb_canvas_edit applying a mixed batch', async () => {
    const rigged = rig()
    await seedBoard(rigged)
    await createCanvasEditTool(rigged.deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'd', type: 'text', text: 'New', x: 0, y: 200 } },
        { op: 'node.patch', id: 'a', patch: { x: 40, text: 'Alpha moved' } },
        { op: 'edge.add', edge: { id: 'e2', from: { node: 'b' }, to: { node: 'c' } } },
        { op: 'node.lock', id: 'b', locked: true },
        { op: 'edge.lock', id: 'e1', locked: true },
        { op: 'node.remove', id: 'c' },
      ],
    } as never)
    await golden('canvas-edit-apply', await record(rigged))
  })

  test('wb_canvas_edit claiming a document that records no kind', async () => {
    const rigged = rig()
    await seedBoard(rigged, false)
    await createCanvasEditTool(rigged.deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.lock', id: 'a', locked: true }],
    } as never)
    await golden('canvas-edit-claims-kind', await record(rigged))
  })

  test('wb_canvas_edit proposing, then continuing the proposal', async () => {
    const rigged = rig()
    await seedBoard(rigged, false)
    const tool = createCanvasEditTool(rigged.deps)
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      author: 'agent',
      ops: [
        { op: 'node.add', node: { id: 'd', type: 'text', text: 'New', x: 0, y: 200 } },
        { op: 'node.patch', id: 'a', patch: { x: 40 } },
      ],
    } as never)
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      proposalId: 'p1',
      ops: [{ op: 'node.remove', id: 'c' }],
    } as never)
    await golden('canvas-edit-propose', await record(rigged))
  })

  test('wb_body_edit applying, then proposing into a proposal that already exists', async () => {
    const rigged = rig()
    await seedNote(rigged)
    const tool = createBodyEditTool(rigged.deps)
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          id: 'c1',
          anchor: at(NOTE, 'one'),
          assumed: 'one',
          text: 'ONE',
          op: 'body.replace',
        },
        {
          id: 'c2',
          anchor: at(NOTE, 'five'),
          assumed: 'five',
          text: 'FIVE',
          op: 'body.replace',
        },
      ],
    } as never)
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      author: 'agent',
      ops: [
        {
          id: 'c3',
          anchor: at(NOTE, 'three'),
          assumed: 'three',
          text: '3',
          op: 'body.replace',
        },
      ],
    } as never)
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      proposalId: 'p1',
      ops: [
        {
          id: 'c4',
          anchor: at(NOTE, 'six'),
          assumed: 'six',
          text: '6',
          op: 'body.replace',
        },
      ],
    } as never)
    await golden('body-edit', await record(rigged))
  })

  test('wb_thread_edit opening, replying to and resolving threads in one batch', async () => {
    const rigged = rig()
    await seedBoard(rigged)
    await createThreadEditTool(rigged.deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          op: 'thread.add',
          anchor: { kind: 'spatial', x: 10, y: 20, nodeId: 'a' },
          body: 'first',
          author: 'agent',
        },
        { op: 'thread.add', threadId: 'doc', anchor: { kind: 'document' }, body: 'whole' },
        { op: 'message.add', threadId: 't1', body: 'reply one' },
        { op: 'message.add', threadId: 't1', body: 'reply two' },
        { op: 'thread.resolve', threadId: 'doc' },
        {
          op: 'thread.add',
          anchor: { kind: 'text', nodeId: 'a', ...span('Alpha beta', 'beta') },
          body: 'passage',
        },
        { op: 'thread.resolve', threadId: 'doc', resolved: false },
      ],
    } as never)
    await golden('thread-edit', await record(rigged))
  })

  test('wb_thread_edit on a document that already holds threads and proposals', async () => {
    const rigged = rig()
    await seed(rigged, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, 'a note about migration')
      writeCommentThread(doc, {
        id: 't1',
        anchor: { kind: 'document' },
        status: 'open',
        createdAt: NOW.toISOString(),
        messages: [{ id: 't1-m1', body: 'old', createdAt: NOW.toISOString() }],
      })
      writeProposal(doc, {
        id: 'p1',
        author: 'someone',
        createdAt: NOW.toISOString(),
        changes: [],
      })
    })
    indexAsMarkdown(rigged)
    await createThreadEditTool(rigged.deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        { op: 'message.add', threadId: 't1', body: 'newer' },
        { op: 'thread.resolve', threadId: 't1' },
        {
          op: 'thread.add',
          anchor: { kind: 'text', ...span('a note about migration', 'migration') },
          body: 'why',
        },
      ],
    } as never)
    await golden('thread-edit-existing', await record(rigged))
  })
})
